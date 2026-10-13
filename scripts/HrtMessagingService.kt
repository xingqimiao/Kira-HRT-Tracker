package com.kiramyao.hrt

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Supplementary push handling (FCM), native and data-only.
 *
 * The server sends a catch-up nudge ("you were due 30 minutes ago and there is no
 * dose logged") as a **data-only** message — no `notification` field. A
 * `notification` field would let the OS draw the tray entry itself while the app is
 * backgrounded, which is exactly what must not happen: it would bypass the shown-key
 * dedup below and the app's own re-check, and a dose could be announced twice.
 *
 * This service parses the data, drops anything it has already shown for the same
 * dose instance, and only then posts a tray notification. It is registered for
 * `com.google.firebase.MESSAGING_EVENT`, replacing the notifications plugin's own
 * service (removed from the merged manifest by the patch script), which auto-shows
 * only when a `notification` field is present and otherwise forwards to a WebView
 * that is not running in the background.
 *
 * The canonical copy lives at `scripts/HrtMessagingService.kt`; `build:android`
 * copies it into the gitignored `gen/` tree on every build (same pattern as
 * `MainActivity.kt`).
 *
 * ponytail: the design's device-side "was this dose already logged locally?"
 * re-check reads the app's plan and dose records, which live in the WebView's
 * *encrypted* localStorage — not reachable from native, and the WebView may not be
 * running at all. What actually closes the double-ring here is (a) the server only
 * pushes an instance that is still unlogged past a 30-minute grace window, and never
 * twice, and (b) the shown-key set below, which survives token redelivery and the
 * app being killed. A sub-second race (user logs the dose in the same instant the
 * server sends) is the known, accepted ceiling.
 */
class HrtMessagingService : FirebaseMessagingService() {

    companion object {
        private const val CHANNEL_ID = "hrt-med"
        private const val PREFS = "hrt-push"
        private const val SHOWN_KEY = "shown"
        private const val SHOWN_MAX_AGE_MS = 3L * 24 * 60 * 60 * 1000 // 3 days, matching Web
        private const val SHOWN_MAX_SIZE = 500
    }

    private fun keyDueMs(key: String): Long? {
        val idx = key.lastIndexOf(':')
        if (idx < 0) return null
        return key.substring(idx + 1).toLongOrNull()
    }

    private fun pruneShown(keys: Set<String>, nowMs: Long): Set<String> {
        val cutoff = nowMs - SHOWN_MAX_AGE_MS
        val kept = keys.filter { k ->
            val due = keyDueMs(k)
            due != null && due >= cutoff
        }
        if (kept.size <= SHOWN_MAX_SIZE) return kept.toSet()
        return kept.sortedByDescending { keyDueMs(it) ?: 0L }.take(SHOWN_MAX_SIZE).toSet()
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // The JS layer pulls the current token on every launch via
        // registerForPushNotifications, so a rotation mid-session is picked up then.
        // Nothing to do here.
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        if (data["kind"] != "dose_overdue") return

        val planId = data["planId"] ?: return
        val dueAt = data["dueAt"] ?: return
        val key = "$planId:$dueAt"

        // Device-side dedup: the same instance can arrive more than once (token
        // redelivery, a retry, both a data and a collapse path). Shown once, ever.
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val rawShown = prefs.getStringSet(SHOWN_KEY, emptySet()) ?: emptySet()
        val nowMs = System.currentTimeMillis()
        val shown = pruneShown(rawShown, nowMs)
        if (shown.contains(key)) {
            if (shown.size != rawShown.size) {
                prefs.edit().putStringSet(SHOWN_KEY, shown).apply()
            }
            return
        }
        val updated = HashSet(shown).apply { add(key) }
        prefs.edit().putStringSet(SHOWN_KEY, updated).apply()

        val alias = data["alias"]
        val dose = data["dose"]
        // Fallbacks follow the app's own language setting: the app resolves them
        // from its packs and stores them via HrtPush.setNotificationFallbacks, so a
        // plan with no alias/dose still reads in the chosen language rather than a
        // hardcoded one. The user's alias/dose still win when the server sends them.
        // Same prefs store as the shown-key set above (both "hrt-push").
        val title = alias ?: prefs.getString(MainActivity.NOTIF_TITLE_KEY, null) ?: getString(R.string.app_name)
        val body = dose ?: prefs.getString(MainActivity.NOTIF_BODY_KEY, null) ?: getString(R.string.app_name)
        show(title, body, key)
    }

    private fun show(title: String, body: String, tag: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "HRT medication",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { enableVibration(true) }
            manager.createNotificationChannel(channel)
        }

        // Tapping opens the app; the SPA routes from its own state.
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pending = PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        manager.notify(tag, tag.hashCode(), notification)
    }
}

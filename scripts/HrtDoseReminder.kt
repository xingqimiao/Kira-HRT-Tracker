package com.kiramyao.hrt

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat

internal object HrtDoseReminder {
    // Same id and settings as the JS-created channel in medPlanNotify.ts —
    // whoever runs first creates it, and the second call is a no-op. The -v2
    // id replaces the vibrating original (Android freezes channel settings at
    // first creation, so quiet settings need a new id).
    private const val CHANNEL_ID = "hrt-med-v2"
    private const val PREFS = "hrt-push"
    private const val SHOWN_KEY = "shown"
    private const val SHOWN_MAX_AGE_MS = 3L * 24 * 60 * 60 * 1000 // 3 days, matching Web
    private const val SHOWN_MAX_SIZE = 500

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

    @Synchronized fun showDoseReminder(context: Context, planId: String, dueAt: String) {
        val key = "$planId:$dueAt"

        // Device-side dedup: the same instance can arrive more than once (token
        // redelivery, a retry, both a data and a collapse path). Shown once, ever.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
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

        // The payload carries only kind/planId/dueAt. The words come from the map
        // the app pushes for the account it is signed in to, so a reminder can never
        // print a previous account's drug name. Falls back to the generic localized
        // line when the plan is not in the map (deleted since, or a label set the
        // app has not refreshed yet).
        var labelTitle: String? = null
        var labelBody: String? = null
        if (planId.isNotEmpty()) {
            try {
                val plans = org.json.JSONObject(prefs.getString(MainActivity.NOTIF_PLANS_KEY, "{}") ?: "{}")
                plans.optJSONObject(planId)?.let {
                    labelTitle = it.optString("title").ifEmpty { null }
                    labelBody = it.optString("body").ifEmpty { null }
                }
            } catch (e: Exception) {
                // Malformed map: the generic line is still correct, only less specific.
            }
        }
        val title = labelTitle ?: prefs.getString(MainActivity.NOTIF_TITLE_KEY, null) ?: context.getString(R.string.app_name)
        val body = labelBody ?: prefs.getString(MainActivity.NOTIF_BODY_KEY, null) ?: context.getString(R.string.app_name)
        show(context, title, body, key)
    }

    private fun show(context: Context, title: String, body: String, tag: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "HRT medication",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                // Quiet: sound only, no vibration (matches the JS channel).
                enableVibration(false)
                // Device locked: only the public version below is shown. Unlocked,
                // the tray shows the real title and dose.
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
            manager.createNotificationChannel(channel)
        }

        // Tapping opens the app; the SPA routes from its own state.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        val pending = PendingIntent.getActivity(
            context,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            // What the lock screen shows instead: one generic localized line, with
            // no alias and no dose (app lock plan §10).
            .setPublicVersion(publicVersion(context))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        manager.notify(tag, tag.hashCode(), notification)
    }

    /** The locked-device rendering: app name, then "you have a reminder". */
    private fun publicVersion(context: Context): Notification {
        val hidden = context.getSharedPreferences(MainActivity.NOTIF_PREFS, Context.MODE_PRIVATE)
            .getString(MainActivity.NOTIF_HIDDEN_KEY, null)
            ?: context.getString(R.string.app_name)
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(hidden)
            .setContentText(context.getString(R.string.app_name))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }
}

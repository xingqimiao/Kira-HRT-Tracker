package com.kiramyao.hrt

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : TauriActivity() {
  private var topInset = 0f
  private var bottomInset = 0f
  private var appWebView: WebView? = null
  private var pendingOAuthUrl: String? = null
  /** Set by onStop, consumed by onStart to decide whether background re-lock is due. */
  private var stoppedAt = 0L
  private var lockBridge: HrtLockBridge? = null
  /** Text waiting for the document picker to return a destination. */
  private var pendingSaveContent: String? = null

  companion object {
    /** SharedPreferences store for the notification-language fallbacks, read by
     *  HrtMessagingService when FCM draws a catch-up notification natively. */
    const val NOTIF_PREFS = "hrt-push"
    const val NOTIF_TITLE_KEY = "notif-title"
    const val NOTIF_BODY_KEY = "notif-body"
    /** The device-locked line: a generic "you have a reminder", never the dose. */
    const val NOTIF_HIDDEN_KEY = "notif-hidden"
    /** JSON map planId -> {title,body}, composed by the app from its own plans.
     *  The push payload itself no longer carries any account text. */
    const val NOTIF_PLANS_KEY = "notif-plans"
    private const val REQUEST_SAVE_FILE = 4711
  }

  /** True while the SPA still has state for system back to pop (a dialog, a
   *  modal, a sub-page). Written from the WebView's JS thread via the
   *  HrtBack interface, read on the UI thread from the back callback. */
  @Volatile private var canPopBack = false

  /** Enabled only while the SPA reports something to pop; the dispatcher then
   *  forwards a `hrt-back` DOM event and the SPA decides what to close. When
   *  nothing can pop this callback is disabled, no callback handles the
   *  gesture, and the system plays its predictive back-to-home animation and
   *  finishes the activity — the app never consumes back at the root.
   *  (scripts/MainActivity.kt is the canonical copy; build:android copies it
   *  over the gen/ one on every build.) */
  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('hrt-back'))",
        null
      )
    }
  }

  inner class SafeArea {
    @JavascriptInterface fun top(): Float = topInset
    @JavascriptInterface fun bottom(): Float = bottomInset
    @JavascriptInterface fun takeOAuthUrl(): String? {
      val url = pendingOAuthUrl
      pendingOAuthUrl = null
      return url
    }
  }

  /** JS side (src/utils/nativeBack.ts) reports whether back has anything to
   *  pop. @JavascriptInterface methods run on a WebView thread, so the flag
   *  is volatile and the callback toggling hops to the UI thread. */
  inner class BackBridge {
    @JavascriptInterface fun setCanPop(v: Boolean) {
      canPopBack = v
      runOnUiThread { backCallback.isEnabled = v }
    }
  }

  /**
   * Supplementary push (FCM): hand the device's FCM token to JS, and let it ask
   * for a fresh one.
   *
   * Deliberately NOT the notifications plugin's `registerForPushNotifications`:
   * that command is gated by `BuildConfig.ENABLE_PUSH_NOTIFICATIONS`, which the
   * plugin's Rust build.rs writes into android/build.properties — a file Gradle
   * reads at configuration time, i.e. before that build.rs has run. The flag
   * therefore lags the build that enables it, and the command would reject on the
   * very build meant to turn push on. Reading the token straight from
   * FirebaseMessaging here has no such ordering hazard and needs no plugin feature.
   *
   * The token is async (a Task), so the result is posted back as a DOM event
   * (`hrt-push-token`, detail `{token, error?}`) rather than returned — the same
   * shape UpdateBridge uses for its progress events.
   */
  inner class PushBridge {
    @JavascriptInterface fun requestToken() {
      try {
        com.google.firebase.messaging.FirebaseMessaging.getInstance().token
          .addOnCompleteListener { task ->
            val detail = if (task.isSuccessful && !task.result.isNullOrEmpty()) {
              "{\"token\":${org.json.JSONObject.quote(task.result)}}"
            } else {
              "{\"token\":\"\",\"error\":${org.json.JSONObject.quote(task.exception?.message ?: "unavailable")}}"
            }
            postPushEvent("hrt-push-token", detail)
          }
      } catch (e: Exception) {
        postPushEvent("hrt-push-token", "{\"token\":\"\",\"error\":${org.json.JSONObject.quote(e.message ?: "unavailable")}}")
      }
    }

    /** Nothing to delete locally; FCM rotates tokens itself. Kept so JS has one
     *  symmetric call it can make on sign-out even though the server-side
     *  unregister is the part that matters. */
    @JavascriptInterface fun deleteToken() {
      try {
        com.google.firebase.messaging.FirebaseMessaging.getInstance().deleteToken()
      } catch (e: Exception) {
        // Best-effort.
      }
    }

    /**
     * The app's own language, for the FCM catch-up notification the OS draws while
     * the WebView is not running (see HrtMessagingService). The app resolves the
     * fallback title/body strings from its own packs and pushes them here on every
     * language change, so the notification follows the in-app language setting
     * rather than a hardcoded default. Shared with HrtMessagingService through
     * SharedPreferences, the one store both processes can read.
     */
    @JavascriptInterface fun setNotificationFallbacks(json: String) {
      try {
        val obj = org.json.JSONObject(json)
        val title = obj.optString("title")
        val body = obj.optString("body")
        val hidden = obj.optString("hidden")
        val plans = obj.optJSONObject("plans")?.toString() ?: "{}"
        getSharedPreferences(NOTIF_PREFS, Context.MODE_PRIVATE).edit()
          .putString(NOTIF_TITLE_KEY, title)
          .putString(NOTIF_BODY_KEY, body)
          .putString(NOTIF_HIDDEN_KEY, hidden)
          .putString(NOTIF_PLANS_KEY, plans)
          .apply()
      } catch (e: Exception) {
        // A malformed payload leaves the last known language in place.
      }
    }
  }

  private fun postPushEvent(name: String, detailJson: String) {
    appWebView?.post {
      appWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('$name',{detail:$detailJson}))", null)
    }
  }

  /**
   * Medication-reminder permission repair.
   *
   * Once this app's notifications are turned OFF in system settings, Android will not
   * show the runtime permission dialog again — `requestPermission()` returns denied at
   * once — so an in-app "enable reminders" button looks dead. The platform's own
   * remedy is to send the user to this app's notification settings, where they can
   * switch it back on; on return, the JS layer re-reads the permission and updates the
   * button (see MedPlanSettings). API 26+ has the dedicated notification page;
   * older releases fall back to the app details page, which also links there.
   */
  inner class NotificationBridge {
    @JavascriptInterface fun openSettings() {
      runOnUiThread {
        try {
          lockBridge?.markExternalFlow()
          val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
          } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
          }
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          startActivity(intent)
        } catch (e: Exception) {
          try {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(fallback)
          } catch (e2: Exception) {
            // Nothing else to try.
          }
        }
      }
    }
  }

  /**
   * In-app APK update (src/utils/nativeUpdate.ts).
   *
   * Handing the .apk URL to the system browser (what `openUrl` does) only makes
   * the browser *download* the file into its own Downloads list — it never offers
   * to install it, so from inside this app "tap update" reads as "jumped away,
   * nothing happened". The platform's own self-update path is: pull the APK into
   * this app's cache, expose it through the FileProvider the manifest already
   * declares, and fire the package-installer intent, which Android shows as the
   * normal "install this update?" prompt.
   *
   * Progress and outcome are reported back as DOM events the JS layer listens for:
   *   hrt-update-progress {pct} · hrt-update-ready {} · hrt-update-error {reason}
   * `reason` is "permission" when the user has not allowed installs from this app
   * yet (we then open that settings screen), otherwise a message string.
   */
  inner class UpdateBridge {
    /**
     * Fetch an APK and hand it to the installer.
     *
     * `sha256` is required and checked while the bytes stream in: the signature check
     * at install time is the real defence, but without this a tampered or truncated
     * download only fails after the user has already committed to installing. An
     * empty digest is refused outright rather than read as "no check" — every
     * manifest this app ships carries one.
     */
    @JavascriptInterface fun download(url: String, sha256: String) {
      // Trust boundary: the URL arrives from JS, so accept only https.
      if (!url.trim().startsWith("https://")) {
        postUpdateEvent("hrt-update-error", "{\"reason\":\"badurl\"}")
        return
      }
      val expected = sha256.trim().lowercase()
      if (!expected.matches(Regex("[0-9a-f]{64}"))) {
        postUpdateEvent("hrt-update-error", "{\"reason\":\"nohash\"}")
        return
      }
      Thread {
        var conn: HttpURLConnection? = null
        try {
          val apk = File(cacheDir, "kira-hrt-update.apk")
          conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
            instanceFollowRedirects = true
          }
          conn.connect()
          val code = conn.responseCode
          if (code !in 200..299) throw Exception("HTTP $code")
          val total = conn.contentLengthLong
          val digest = java.security.MessageDigest.getInstance("SHA-256")
          conn.inputStream.use { input ->
            apk.outputStream().use { output ->
              val buf = ByteArray(64 * 1024)
              var read: Int
              var done = 0L
              var lastPct = -1
              while (input.read(buf).also { read = it } > 0) {
                output.write(buf, 0, read)
                digest.update(buf, 0, read)
                done += read
                if (total > 0) {
                  val pct = ((done * 100) / total).toInt()
                  if (pct != lastPct) { lastPct = pct; postUpdateEvent("hrt-update-progress", "{\"pct\":$pct}") }
                }
              }
            }
          }
          val actual = digest.digest().joinToString("") { b -> "%02x".format(b) }
          if (actual != expected) {
            apk.delete()
            postUpdateEvent("hrt-update-error", "{\"reason\":\"checksum\"}")
            return@Thread
          }
          promptInstall(apk)
        } catch (e: Exception) {
          postUpdateEvent("hrt-update-error", "{\"reason\":${org.json.JSONObject.quote(e.message ?: "error")}}")
        } finally {
          conn?.disconnect()
        }
      }.start()
    }
  }

  private fun postUpdateEvent(name: String, detailJson: String) {
    appWebView?.post {
      appWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('$name',{detail:$detailJson}))", null)
    }
  }

  private fun promptInstall(apk: File) {
    runOnUiThread {
      try {
        // Android 8+ gates per-app installs behind "install unknown apps". If it
        // is off, send the user straight to that toggle for this package rather
        // than dead-ending; the JS side invites a retry once it is back.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
          postUpdateEvent("hrt-update-error", "{\"reason\":\"permission\"}")
          lockBridge?.markExternalFlow()
          val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
          settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          startActivity(settings)
          return@runOnUiThread
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(intent)
        postUpdateEvent("hrt-update-ready", "{}")
      } catch (e: Exception) {
        postUpdateEvent("hrt-update-error", "{\"reason\":${org.json.JSONObject.quote(e.message ?: "error")}}")
      }
    }
  }

  /**
   * Export to a user-chosen file.
   *
   * A WebView ignores `<a download>` unless a DownloadListener is installed, so
   * the web export path silently did nothing inside the APK. `ACTION_CREATE_DOCUMENT`
   * is the platform's own "save as" surface — the user picks the location, and
   * no storage permission is involved.
   */
  inner class ExportBridge {
    @JavascriptInterface fun save(name: String, mime: String, content: String) {
      pendingSaveContent = content
      runOnUiThread {
        try {
          val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_TITLE, name)
          }
          @Suppress("DEPRECATION")
          startActivityForResult(intent, REQUEST_SAVE_FILE)
        } catch (e: Exception) {
          pendingSaveContent = null
          Toast.makeText(this@MainActivity, e.message ?: "save failed", Toast.LENGTH_SHORT).show()
        }
      }
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_SAVE_FILE) return
    val content = pendingSaveContent
    pendingSaveContent = null
    if (resultCode != RESULT_OK || data?.data == null || content == null) return
    try {
      contentResolver.openOutputStream(data.data!!)?.use { out ->
        out.write(content.toByteArray(Charsets.UTF_8))
        out.flush()
      }
      Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
    } catch (e: Exception) {
      Toast.makeText(this, e.message ?: "save failed", Toast.LENGTH_SHORT).show()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    pendingOAuthUrl = intent?.dataString
    // Transparent, system-following bars. `enableEdgeToEdge()` with no args applies a
    // default LIGHT scrim (≈90% white) to the navigation bar in light mode; on launch
    // that scrim is what showed as a white strip along the bottom before the app
    // painted. Passing transparent scrims removes it entirely and lets the page's own
    // (now correctly themed) background show through; the icon tint still follows the
    // system's dark/light setting.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, backCallback)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val url = intent?.dataString ?: return
    // Returning from the OAuth browser is the end of that external flow: the
    // callback cannot wait for the JS side to report it.
    lockBridge?.endExternalFlow()
    pendingOAuthUrl = url
    appWebView?.postDelayed({
      appWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('hrt-oauth-callback',{detail:${org.json.JSONObject.quote(url)}}))", null)
      pendingOAuthUrl = null
    }, 500)
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    // The WebView's own background shows before the page paints. Match the system's
    // light/dark setting so a light-mode launch does not flash a black rectangle
    // between the (now light) native window and the page's first paint. The light
    // value is the app's `--color-m3-surface`; the dark value is unchanged.
    val nightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    webView.setBackgroundColor(if (nightMode) Color.rgb(13, 13, 18) else Color.rgb(251, 251, 252))
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(SafeArea(), "HrtSafeArea")
    webView.addJavascriptInterface(BackBridge(), "HrtBack")
    webView.addJavascriptInterface(UpdateBridge(), "HrtUpdate")
    webView.addJavascriptInterface(PushBridge(), "HrtPush")
    webView.addJavascriptInterface(NotificationBridge(), "HrtNotif")
    webView.addJavascriptInterface(ExportBridge(), "HrtExport")
    val lock = HrtLockBridge(this) { appWebView }
    lockBridge = lock
    webView.addJavascriptInterface(lock, "HrtLock")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = resources.displayMetrics.density
      topInset = bars.top / density
      bottomInset = bars.bottom / density
      webView.post { webView.evaluateJavascript("window.dispatchEvent(new Event('hrt-safe-area-change'))", null) }
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** WryActivity's own back callback (webview history) would sit between the
   *  system and [backCallback] and finish the activity whenever the SPA has
   *  no browser history — which is always, this is an SPA without pushState.
   *  Opting out leaves back handling entirely to the callback above. */
  override val handleBackNavigation: Boolean = false

  /** Background re-lock: only a stop of 5 s or more counts, and only when no
   *  external flow (OAuth, file picker, settings) is open. The WebView is not
   *  reloaded; the JS layer draws the unlock surface over it. */
  override fun onStop() {
    stoppedAt = SystemClock.elapsedRealtime()
    super.onStop()
  }

  override fun onStart() {
    super.onStart()
    lockBridge?.notifyEnrollmentReturn()
    val stopped = stoppedAt
    stoppedAt = 0L
    if (stopped > 0L) {
      val away = SystemClock.elapsedRealtime() - stopped
      if (lockBridge?.shouldRelock(away) == true) lockBridge?.notifyRelocked()
    }
  }
}

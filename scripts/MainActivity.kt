package com.kiramyao.hrt

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
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
    @JavascriptInterface fun download(url: String) {
      // Trust boundary: the URL arrives from JS, so accept only https.
      if (!url.trim().startsWith("https://")) {
        postUpdateEvent("hrt-update-error", "{\"reason\":\"badurl\"}")
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
          conn.inputStream.use { input ->
            apk.outputStream().use { output ->
              val buf = ByteArray(64 * 1024)
              var read: Int
              var done = 0L
              var lastPct = -1
              while (input.read(buf).also { read = it } > 0) {
                output.write(buf, 0, read)
                done += read
                if (total > 0) {
                  val pct = ((done * 100) / total).toInt()
                  if (pct != lastPct) { lastPct = pct; postUpdateEvent("hrt-update-progress", "{\"pct\":$pct}") }
                }
              }
            }
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

  override fun onCreate(savedInstanceState: Bundle?) {
    pendingOAuthUrl = intent?.dataString
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, backCallback)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val url = intent?.dataString ?: return
    pendingOAuthUrl = url
    appWebView?.postDelayed({
      appWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('hrt-oauth-callback',{detail:${org.json.JSONObject.quote(url)}}))", null)
      pendingOAuthUrl = null
    }, 500)
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    webView.setBackgroundColor(Color.rgb(13, 13, 18))
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(SafeArea(), "HrtSafeArea")
    webView.addJavascriptInterface(BackBridge(), "HrtBack")
    webView.addJavascriptInterface(UpdateBridge(), "HrtUpdate")
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
}

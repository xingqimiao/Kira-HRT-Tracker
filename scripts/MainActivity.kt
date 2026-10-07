package com.kiramyao.hrt

import android.os.Bundle
import android.content.Intent
import android.graphics.Color
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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

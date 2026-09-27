package com.kiramyao.hrt

import android.os.Bundle
import android.content.Intent
import android.graphics.Color
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var topInset = 0f
  private var bottomInset = 0f
  private var appWebView: WebView? = null
  private var pendingOAuthUrl: String? = null

  inner class SafeArea {
    @JavascriptInterface fun top(): Float = topInset
    @JavascriptInterface fun bottom(): Float = bottomInset
    @JavascriptInterface fun takeOAuthUrl(): String? {
      val url = pendingOAuthUrl
      pendingOAuthUrl = null
      return url
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    pendingOAuthUrl = intent?.dataString
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
}

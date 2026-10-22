package com.kiramyao.hrt

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Biometric app lock — the native half of `docs/android-app-lock-plan.md`.
 *
 * The record key K never changes. This class wraps it in a second, AndroidKeyStore
 * key `B` that can only be used after a BIOMETRIC_STRONG authentication, so a cold
 * start without a successful prompt cannot decrypt any local record. The envelope
 * (IV + ciphertext of K under B) lives in `SharedPreferences("hrt-lock")`; B itself
 * is non-exportable and never leaves the Keystore.
 *
 * Results are posted as DOM events, matching the `HrtBack` / `HrtPush` bridges:
 *
 *   hrt-lock-result { ok, callbackId, key?, error? }
 *   hrt-lock-state  { locked: true }        (background re-lock)
 *
 * `error` is one of: cancelled, lockout, unavailable, no_key, error.
 *
 * scripts/HrtLockBridge.kt is the canonical copy; build:android copies it into the
 * gitignored gen/ tree on every build, the same arrangement as MainActivity.kt.
 */
class HrtLockBridge(
    private val activity: Activity,
    private val webView: () -> WebView?,
) {
    companion object {
        private const val PREFS = "hrt-lock"
        private const val PREF_ENABLED = "enabled"
        private const val PREF_ENVELOPE = "envelope"
        private const val PREF_BACKGROUND_LOCK = "background-lock"

        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "hrt-lock-key-v1"
        private const val GCM_TAG_BITS = 128

        /** OEM fallback: Android normally reports lockout itself; this is the backstop. */
        private const val MAX_FAILURES = 5
    }

    private var failures = 0

    /** External activities the user is expected to leave the app for (OAuth, file
     *  picker, system settings). Background re-lock must not fire while one is open. */
    @Volatile private var externalFlowDepth = 0
    @Volatile private var externalFlowAt = 0L

    /** Set while the system enrolment screen is open, so Settings can continue. */
    @Volatile private var awaitingEnrollment = false

    private val prefs: android.content.SharedPreferences
        get() = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---------------------------------------------------------------- queries

    @JavascriptInterface
    fun isEnabled(): Boolean = prefs.getBoolean(PREF_ENABLED, false)

    @JavascriptInterface
    fun isBackgroundLock(): Boolean = prefs.getBoolean(PREF_BACKGROUND_LOCK, false)

    @JavascriptInterface
    fun setBackgroundLock(enabled: Boolean) {
        prefs.edit().putBoolean(PREF_BACKGROUND_LOCK, enabled).apply()
    }

    /** "ok" | "not_enrolled" | "weak_only" | "no_hardware" | "hw_unavailable". */
    @JavascriptInterface
    fun canAuthenticate(): String {
        val manager = BiometricManager.from(activity)
        return when (manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> "ok"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
                // Distinguish "nothing enrolled" from "only weak biometrics" so the
                // settings copy can say which one applies.
                if (manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) ==
                    BiometricManager.BIOMETRIC_SUCCESS
                ) "weak_only" else "not_enrolled"
            }
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no_hardware"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw_unavailable"
            else -> "unavailable"
        }
    }

    /** Send the user to the system's biometric enrolment screen. */
    @JavascriptInterface
    fun openEnrollment() {
        markExternalFlow()
        awaitingEnrollment = true
        activity.runOnUiThread {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(Settings.ACTION_BIOMETRIC_ENROLL).putExtra(
                    Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED,
                    BiometricManager.Authenticators.BIOMETRIC_STRONG,
                )
            } else {
                Intent(Settings.ACTION_SECURITY_SETTINGS)
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                activity.startActivity(intent)
            } catch (_: Exception) {
                // Leave the app where it is; the settings row still shows the reason.
            }
        }
    }

    // ---------------------------------------------------------------- flows

    /**
     * Turn the lock on: authenticate, create B, wrap K, persist the envelope.
     * `keyBase64` is the existing record key, read by the WebView from secure storage.
     * Nothing is written unless the prompt succeeds.
     */
    @JavascriptInterface
    fun enable(keyBase64: String, callbackId: String, title: String, negative: String) {
        if (canAuthenticate() != "ok") {
            emitResult(callbackId, "unavailable")
            return
        }
        val plain = try {
            Base64.decode(keyBase64, Base64.NO_WRAP)
        } catch (_: Exception) {
            emitResult(callbackId, "error")
            return
        }
        activity.runOnUiThread {
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, ensureKey())
                startPrompt(cipher, callbackId, "enable", plain, title, negative)
            } catch (e: Exception) {
                emitResult(callbackId, "error", e.message)
            }
        }
    }

    /** Unlock: decrypt the envelope and hand K back to the WebView. */
    @JavascriptInterface
    fun authenticate(callbackId: String, title: String, negative: String) {
        if (!isEnabled()) {
            emitResult(callbackId, "no_key")
            return
        }
        val envelope = readEnvelope()
        if (envelope == null) {
            emitResult(callbackId, "no_key")
            return
        }
        activity.runOnUiThread {
            try {
                val cipher = decryptCipher(envelope.first)
                startPrompt(cipher, callbackId, "authenticate", envelope.second, title, negative)
            } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
                // A new fingerprint was enrolled (or all were removed), and the key is
                // set to invalidate on that. It can never be used again, so the local
                // envelope is unrecoverable — a distinct code, because "error" gives
                // the screen nothing to say and nothing to offer.
                emitResult(callbackId, "invalidated")
            } catch (e: Exception) {
                emitResult(callbackId, "error", e.message)
            }
        }
    }

    /**
     * Turn the lock off: authenticate and hand K back so the WebView can restore it
     * to secure storage. The envelope and B are only removed by [confirmDisabled],
     * once that write has succeeded.
     */
    @JavascriptInterface
    fun disable(callbackId: String, title: String, negative: String) {
        if (!isEnabled()) {
            emitResult(callbackId, "no_key")
            return
        }
        val envelope = readEnvelope()
        if (envelope == null) {
            emitResult(callbackId, "no_key")
            return
        }
        activity.runOnUiThread {
            try {
                val cipher = decryptCipher(envelope.first)
                startPrompt(cipher, callbackId, "disable", envelope.second, title, negative)
            } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
                emitResult(callbackId, "invalidated")
            } catch (e: Exception) {
                emitResult(callbackId, "error", e.message)
            }
        }
    }

    /** Called by JS after K has been written back to secure storage. */
    @JavascriptInterface
    fun confirmDisabled() {
        prefs.edit()
            .remove(PREF_ENVELOPE)
            .putBoolean(PREF_ENABLED, false)
            .commit()
        try {
            KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(ALIAS)
        } catch (_: Exception) {
            // Nothing else to clean up.
        }
    }

    // ---------------------------------------------------------------- state

    @JavascriptInterface
    fun lockNow() {
        emit("hrt-lock-state", JSONObject().put("locked", true))
    }

    /** FLAG_SECURE on the unlock / clock screens: no recent-task thumbnail. */
    @JavascriptInterface
    fun setSecureScreen(enabled: Boolean) {
        activity.runOnUiThread {
            if (enabled) {
                activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
    }

    // ---------------------------------------------------------------- external flows

    @JavascriptInterface
    fun beginExternalFlow() {
        externalFlowDepth += 1
        externalFlowAt = System.currentTimeMillis()
    }

    @JavascriptInterface
    fun endExternalFlow() {
        externalFlowDepth = 0
    }

    /** Native-initiated leave (settings, installer): exempt from background re-lock. */
    fun markExternalFlow() {
        externalFlowDepth += 1
        externalFlowAt = System.currentTimeMillis()
    }

    /** Called from the activity's onStart. Returns true when the UI must re-lock. */
    fun shouldRelock(onStopElapsedMs: Long): Boolean {
        if (!isEnabled() || !prefs.getBoolean(PREF_BACKGROUND_LOCK, false)) return false
        // An external flow that never reported back must not exempt the app forever.
        if (externalFlowDepth > 0 && System.currentTimeMillis() - externalFlowAt < 180_000) return false
        externalFlowDepth = 0
        return onStopElapsedMs >= 5_000
    }

    fun notifyRelocked() {
        emit("hrt-lock-state", JSONObject().put("locked", true))
    }

    /**
     * Android's onStart after the enrolment screen. Reports whether the device now
     * has a strong biometric so Settings can continue the enable flow by itself
     * (app lock plan §8.1.1).
     */
    fun notifyEnrollmentReturn() {
        if (!awaitingEnrollment) return
        awaitingEnrollment = false
        emit("hrt-lock-enroll-return", JSONObject().put("status", canAuthenticate()))
    }

    // ---------------------------------------------------------------- prompt

    private fun startPrompt(
        cipher: Cipher,
        callbackId: String,
        purpose: String,
        payload: ByteArray,
        title: String,
        negative: String,
    ) {
        val executor = ContextCompat.getMainExecutor(activity)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val authenticated = result.cryptoObject?.cipher ?: run {
                    emitResult(callbackId, "error", "no cipher")
                    return
                }
                try {
                    when (purpose) {
                        "enable" -> {
                            val iv = Base64.encodeToString(authenticated.iv, Base64.NO_WRAP)
                            val sealed = authenticated.doFinal(payload)
                            val envelope = "$iv:${Base64.encodeToString(sealed, Base64.NO_WRAP)}"
                            val written = prefs.edit()
                                .putString(PREF_ENVELOPE, envelope)
                                .putBoolean(PREF_ENABLED, true)
                                .commit()
                            if (!written) {
                                prefs.edit().remove(PREF_ENVELOPE).putBoolean(PREF_ENABLED, false).commit()
                                emitResult(callbackId, "error", "prefs")
                            } else {
                                failures = 0
                                emitResult(callbackId, null)
                            }
                        }
                        "authenticate", "disable" -> {
                            val plain = authenticated.doFinal(payload)
                            failures = 0
                            emitResult(
                                callbackId,
                                null,
                                key = Base64.encodeToString(plain, Base64.NO_WRAP),
                            )
                        }
                    }
                } catch (e: Exception) {
                    emitResult(callbackId, "error", e.message)
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                failures += 1
                val lockedOut = errorCode == BiometricPrompt.ERROR_LOCKOUT ||
                    errorCode == BiometricPrompt.ERROR_LOCKOUT_PERMANENT ||
                    failures >= MAX_FAILURES
                emitResult(
                    callbackId,
                    if (lockedOut) "lockout" else "cancelled",
                    errString.toString(),
                )
            }

            override fun onAuthenticationFailed() {
                failures += 1
            }
        }

        val prompt = BiometricPrompt(activity as androidx.fragment.app.FragmentActivity, executor, callback)
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText(negative)
            .setConfirmationRequired(false)
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    // ---------------------------------------------------------------- crypto

    private fun ensureKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        if (store.containsAlias(ALIAS)) {
            return (store.getEntry(ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // Enrolling a new fingerprint invalidates the key, so someone who can
            // unlock the phone (with its PIN) cannot add their own finger and then
            // read this app's local records. The trade is that the user must sign
            // back in after enrolling a finger — the app says so on the lock screen
            // and restores from the server, so the records are not lost.
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(0)
        }
        generator.init(builder.build())
        return generator.generateKey()
    }

    private fun loadKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        return (store.getEntry(ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
    }

    private fun decryptCipher(iv: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, loadKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        }

    /** envelope = base64(iv) ":" base64(ciphertext). */
    private fun readEnvelope(): Pair<ByteArray, ByteArray>? {
        val raw = prefs.getString(PREF_ENVELOPE, null) ?: return null
        val parts = raw.split(":", limit = 2)
        if (parts.size != 2) return null
        return try {
            Base64.decode(parts[0], Base64.NO_WRAP) to Base64.decode(parts[1], Base64.NO_WRAP)
        } catch (_: Exception) {
            null
        }
    }

    // ---------------------------------------------------------------- events

    private fun emitResult(callbackId: String, error: String?, message: String? = null, key: String? = null) {
        val detail = JSONObject()
            .put("callbackId", callbackId)
            .put("ok", error == null)
        if (key != null) detail.put("key", key)
        if (error != null) detail.put("error", error)
        if (message != null) detail.put("message", message)
        emit("hrt-lock-result", detail)
    }

    private fun emit(name: String, detail: JSONObject) {
        val payload = detail.toString()
        webView()?.post {
            webView()?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('$name',{detail:$payload}))",
                null,
            )
        }
    }
}

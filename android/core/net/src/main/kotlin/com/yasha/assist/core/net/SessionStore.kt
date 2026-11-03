package com.yasha.assist.core.net

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// better-auth session token + server base URL, at rest in EncryptedSharedPreferences
// (decision D-2, PLAN.md §8). Cleared on sign-out / 401.
class SessionStore(context: Context) : SessionAccess {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "yasha_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BASE_URL, value.trimEnd('/')).apply()

    override var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    override var email: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(value) = prefs.edit().putString(KEY_EMAIL, value).apply()

    // Account locale (user.locale mirror). Cleared with the session: signed
    // out ⇒ the app falls back to the static default language.
    var locale: String?
        get() = prefs.getString(KEY_LOCALE, null)
        set(value) = prefs.edit().putString(KEY_LOCALE, value).apply()

    override var dismissedUpdateCode: Int
        get() = prefs.getInt(KEY_DISMISSED_UPDATE, 0)
        set(value) = prefs.edit().putInt(KEY_DISMISSED_UPDATE, value).apply()

    override var autoDownloadWifi: Boolean
        get() = prefs.getBoolean(KEY_AUTO_DOWNLOAD, false)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_DOWNLOAD, value).apply()

    override fun signedIn() = !token.isNullOrEmpty()

    // One-shot injection of the credentials baked into a per-user APK built by
    // the web app (BuildConfig values). Never re-seeds after a manual sign-out.
    fun seed(seedUrl: String, seedToken: String, seedEmail: String) {
        if (seedToken.isEmpty() || prefs.getBoolean(KEY_SEEDED, false)) return
        prefs.edit()
            .putBoolean(KEY_SEEDED, true)
            .putString(KEY_BASE_URL, seedUrl.trimEnd('/'))
            .putString(KEY_TOKEN, seedToken)
            .putString(KEY_EMAIL, seedEmail.ifEmpty { null })
            .apply()
    }

    override fun clearSession() = prefs.edit()
        .remove(KEY_TOKEN)
        .remove(KEY_EMAIL)
        .remove(KEY_LOCALE)
        .apply()

    companion object {
        const val COOKIE_NAME = "better-auth.session_token"

        // better-auth prefixes the cookie name with __Secure- when the server
        // runs on https (secure cookies). The prefix is part of the cookie's
        // identity — the server only reads the name it issued — so requests
        // carry the token under both spellings.
        const val SECURE_COOKIE_NAME = "__Secure-$COOKIE_NAME"

        private const val KEY_BASE_URL = "base_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_EMAIL = "email"
        private const val KEY_LOCALE = "locale"
        private const val KEY_SEEDED = "seeded"
        private const val KEY_DISMISSED_UPDATE = "dismissed_update_code"
        private const val KEY_AUTO_DOWNLOAD = "auto_download_wifi"

        fun isSessionCookie(name: String) = name == COOKIE_NAME || name == SECURE_COOKIE_NAME

        fun cookieHeader(token: String) = "$COOKIE_NAME=$token; $SECURE_COOKIE_NAME=$token"

        // Extracts the session token from a Set-Cookie header list (sign-in/sign-up).
        fun parseSessionCookie(setCookies: List<String>): String? = setCookies
            .firstNotNullOfOrNull { header ->
                val pair = header.substringBefore(';').trim()
                val (name, value) = pair.split('=', limit = 2).let {
                    if (it.size == 2) it[0].trim() to it[1].trim() else return@firstNotNullOfOrNull null
                }
                if (isSessionCookie(name) && value.isNotEmpty()) value else null
            }
    }
}

package com.yasha.assist.core.net

import android.content.Context
import android.content.res.Configuration
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale

// Account-driven app language: the app renders in the ACCOUNT locale
// (user.locale from GET /api/me), never the device locale — changing the
// system language must not change the app. Fallback when signed out or the
// account locale is null/unknown: the static default (en).
//
// The effective tag lives here (process-wide); components wrap their base
// context via wrap() in attachBaseContext, so resources resolve in that
// language regardless of the device setting.
object AppLocale {
    const val DEFAULT_TAG = "en"
    val SUPPORTED = listOf("en", "fr")

    @Volatile
    var tag: String = DEFAULT_TAG

    /** Account value wins; null/unknown tags fall back to the default (never the device locale). */
    fun resolve(accountTag: String?): String =
        if (accountTag != null && accountTag in SUPPORTED) accountTag else DEFAULT_TAG

    /** user.locale from a GET /api/me payload (null on missing/garbage). */
    fun localeFromMeJson(raw: String): String? = try {
        val user = (Json.parseToJsonElement(raw) as? JsonObject)?.get("user") as? JsonObject
        user?.get("locale")?.jsonPrimitive?.contentOrNull
    } catch (_: Exception) {
        null
    }

    /** Context whose configuration forces the effective app language. */
    fun wrap(context: Context): Context {
        val config = Configuration(context.resources.configuration)
        config.setLocale(Locale(tag))
        return context.createConfigurationContext(config)
    }
}

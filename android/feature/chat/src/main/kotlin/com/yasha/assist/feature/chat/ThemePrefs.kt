package com.yasha.assist.feature.chat

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

// Per-device appearance theme (issue #15 parity with the web theme toggle):
// "system" (default) | "light" | "dark". Deliberately NOT the account — the
// web toggle is likewise a per-browser preference. Compose-backed so picking
// a theme repaints the app without a recreate.
object ThemePrefs {
    const val SYSTEM = "system"
    const val LIGHT = "light"
    const val DARK = "dark"

    private const val PREFS = "yasha_prefs"
    private const val KEY_THEME = "theme"

    var mode by mutableStateOf(SYSTEM)
        private set

    fun load(context: Context) {
        mode = normalize(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_THEME, SYSTEM))
    }

    fun set(context: Context, value: String) {
        val v = normalize(value)
        mode = v
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_THEME, v).apply()
    }

    /** null ⇒ follow the system dark mode; otherwise the forced light/dark. */
    fun darkOverride(): Boolean? = when (mode) {
        LIGHT -> false
        DARK -> true
        else -> null
    }

    private fun normalize(value: String?) = when (value) {
        LIGHT, DARK -> value
        else -> SYSTEM
    }
}

package com.yasha.assist.core.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// Gemini-inspired tokens (see PLAN.md §M6): blue accent, brand gradient used for the
// sparkle mark and the overlay glow sweep; light is the reference look, dark follows.
val GeminiBlue = Color(0xFF1B6EF3)
val GeminiBlueSoft = Color(0xFF8AB4F8)
val BrandGradient = listOf(Color(0xFF4285F4), Color(0xFF9B72CB), Color(0xFFD96570), Color(0xFF0ED2D8))
val SurfaceDark = Color(0xFF1E1F20)
val BgDark = Color(0xFF000000)

@Immutable
data class YashaPalette(
    val userBubble: Color,
    val iconGray: Color,
    val composerOutline: Color,
    val drawerSurface: Color,
    val homeGlow: Color,
    val disclaimer: Color,
    // Warn state (issue #8): amber tool chip when output was truncated.
    val warnAmber: Color,
)

private val LightPalette = YashaPalette(
    userBubble = Color(0xFFF0F4F9),
    iconGray = Color(0xFF5F6368),
    composerOutline = Color(0xFFD2D5D9),
    drawerSurface = Color(0xFFF8FAFD),
    homeGlow = Color(0x8CB7D7FE),
    disclaimer = Color(0xFF5F6368),
    warnAmber = Color(0xFFB45309),
)

private val DarkPalette = YashaPalette(
    userBubble = Color(0xFF282A2E),
    iconGray = Color(0xFFC4C7C5),
    composerOutline = Color(0xFF444746),
    drawerSurface = SurfaceDark,
    homeGlow = Color(0x4D1A3A52),
    disclaimer = Color(0xFFC4C7C5),
    warnAmber = Color(0xFFFBBF24),
)

val LocalYashaPalette = staticCompositionLocalOf { LightPalette }

private val LightScheme = lightColorScheme(
    primary = Color(0xFF0B57D0),
    onPrimary = Color.White,
    secondary = Color(0xFF0B57D0),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF1F1F1F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1F1F1F),
    surfaceVariant = Color(0xFFEFF3F8),
    onSurfaceVariant = Color(0xFF444746),
    outline = Color(0xFF747775),
)

private val DarkScheme = darkColorScheme(
    primary = GeminiBlue,
    onPrimary = Color.White,
    secondary = GeminiBlueSoft,
    background = BgDark,
    onBackground = Color(0xFFF0F0F0),
    surface = SurfaceDark,
    onSurface = Color(0xFFF0F0F0),
    surfaceVariant = Color(0xFF282A2C),
    onSurfaceVariant = Color(0xFFC4C7C5),
    outline = Color(0xFF8E918F),
)

@Composable
fun YashaTheme(darkOverride: Boolean? = null, content: @Composable () -> Unit) {
    val dark = darkOverride ?: isSystemInDarkTheme()
    val palette = if (dark) DarkPalette else LightPalette
    androidx.compose.runtime.CompositionLocalProvider(LocalYashaPalette provides palette) {
        MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
    }
}

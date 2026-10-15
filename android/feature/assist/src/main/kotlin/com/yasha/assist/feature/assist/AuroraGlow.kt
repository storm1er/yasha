package com.yasha.assist.feature.assist

import android.graphics.RuntimeShader
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import kotlin.math.sin
import kotlinx.coroutines.isActive

// Gemini-style entry glow: teal/blue waves climbing the screen edges + a bright
// strip along the bottom (warm accent on the right), alive for ~5 s, then a
// ~1.2 s fade-out. Drawn over the frozen screenshot, under the selection layer.
private const val LIVE_SECONDS = 5f
private const val FADE_SECONDS = 1.2f

private const val AURORA_AGSL = """
    uniform float2 resolution;
    uniform float time;
    uniform float alpha;
    uniform float pill;
    half4 main(float2 c) {
        float w = resolution.x, h = resolution.y;
        float nx = c.x / w, ny = c.y / h;
        float waveX = sin(c.x * 0.021 - time * 1.9) * 0.5 + 0.5;
        float waveE = sin(ny * 26.0 - time * 1.6) * 0.5 + 0.5;

        if (pill > 0.5) {
            // Loading-bar variant: slow blue waves inside the pill, clipped to its bounds.
            float e = 0.34 + 0.10 * sin(nx * 6.0 + time * 0.9) + 0.04 * sin(nx * 13.0 - time * 1.3);
            float s = clamp(1.0 - (1.0 - ny) / e, 0.0, 1.0);
            s = s * s * (3.0 - 2.0 * s);
            float r = 0.55 + 0.05 * sin(nx * 4.0 + time * 0.8);
            float gx = nx - 0.5, gy = (ny - 1.0) * 1.4;
            float core = pow(max(0.0, 1.0 - sqrt(gx * gx + gy * gy) / r), 2.0);
            float g = max(s * 0.8, core);
            float3 col = mix(float3(0.10, 0.42, 0.95), float3(0.15, 0.85, 1.0), 0.5 + 0.5 * sin(nx * 5.0 - time * 0.7));
            col *= g * 1.5;
            float a = clamp(g * 1.2, 0.0, 1.0) * alpha;
            return half4(half3(col) * a, a);
        }

        // Full-width bottom waves: the top edge of each strip undulates across the
        // whole screen width (teal = fast/fine, warm = slow/coarse).
        float e1 = 0.12 + 0.07 * sin(nx * 8.0 + time * 2.2) + 0.03 * sin(nx * 19.0 - time * 3.1);
        float strip1 = clamp(1.0 - (1.0 - ny) / max(e1, 0.01), 0.0, 1.0);
        strip1 = strip1 * strip1 * (3.0 - 2.0 * strip1);
        strip1 *= mix(0.6, 1.0, waveX);

        float e2 = 0.10 + 0.06 * sin(nx * 5.0 - time * 1.35) + 0.02 * sin(nx * 13.0 + time * 2.2);
        float strip2 = clamp(1.0 - (1.0 - ny) / max(e2, 0.01), 0.0, 1.0);
        strip2 = strip2 * strip2 * (3.0 - 2.0 * strip2);
        strip2 *= mix(0.5, 1.0, sin(nx * 6.0 - time * 1.4) * 0.5 + 0.5);

        // Radial cores add height/brightness under the composer.
        float r = 0.62 + 0.11 * sin(nx * 9.0 + time * 2.1);
        float gx = nx - 0.5, gy = (ny - 1.0) * 1.6;
        float bottom = pow(max(0.0, 1.0 - sqrt(gx * gx + gy * gy) / r), 1.7);
        bottom *= mix(0.75, 1.0, waveX);

        float r2 = 0.5 + 0.12 * sin(nx * 5.0 - time * 1.25);
        float wx = nx - 0.72, wy = (ny - 1.0) * 1.6;
        float warm = pow(max(0.0, 1.0 - sqrt(wx * wx + wy * wy) / r2), 1.8);
        warm *= mix(0.55, 1.0, sin(nx * 6.0 - time * 1.4) * 0.5 + 0.5);

        // Edge bands: fade toward the sides, brighter near the bottom, wave along height.
        float edge = min(nx, 1.0 - nx);
        float band = pow(max(0.0, 1.0 - edge * 9.0), 1.9);
        band *= mix(0.25, 1.0, ny * ny) * mix(0.45, 1.0, waveE);

        float glow = max(bottom, max(band * 0.9, strip1));
        float warmG = max(warm, strip2 * 0.9);

        float3 col = float3(0.13, 0.82, 0.95) * glow * 1.35;
        col += float3(0.15, 0.45, 1.0) * bottom * (0.4 + 0.6 * waveX);
        col += float3(1.0, 0.36, 0.44) * warmG * 1.1;

        float a = clamp(max(glow, warmG) * 1.1, 0.0, 1.0) * alpha;
        return half4(half3(col) * a, a);
    }
"""

@Composable
fun AuroraOverlay(modifier: Modifier = Modifier, pill: Boolean = false, active: Boolean = true) {
    var time by remember { mutableFloatStateOf(0f) }
    var alpha by remember { mutableFloatStateOf(1f) }
    var done by remember { mutableStateOf(false) }
    // RuntimeShader (AGSL) needs API 33; older devices get the static variant below.
    val shader = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching { RuntimeShader(AURORA_AGSL) }.getOrNull()
        } else {
            null
        }
    }

    LaunchedEffect(pill) {
        var first = -1L
        while (isActive && !done) {
            withFrameNanos { now ->
                if (first < 0) first = now
                val el = (now - first) / 1_000_000_000f
                time = el
                if (!pill) {
                    alpha = when {
                        el <= 0.25f -> el / 0.25f
                        el <= LIVE_SECONDS -> 1f
                        el >= LIVE_SECONDS + FADE_SECONDS -> { done = true; 0f }
                        else -> 1f - (el - LIVE_SECONDS) / FADE_SECONDS
                    }
                }
            }
        }
    }

    if (done || !active) return

    Canvas(modifier) {
        val w = size.width
        val h = size.height
        if (shader != null) {
            shader.setFloatUniform("resolution", w, h)
            shader.setFloatUniform("time", time)
            shader.setFloatUniform("alpha", alpha)
            shader.setFloatUniform("pill", if (pill) 1f else 0f)
            drawRect(brush = ShaderBrush(shader))
        } else {
            val pulse = alpha * (0.75f + 0.25f * sin(time * 3f))
            val teal = Color(0xFF10A6BF)
            val warm = Color(0xFFF2596B)
            drawRect(
                brush = Brush.verticalGradient(
                    0f to Color.Transparent,
                    0.72f to teal.copy(alpha = 0.12f * pulse),
                    1f to teal.copy(alpha = 0.85f * pulse),
                ),
            )
            drawRect(
                brush = Brush.horizontalGradient(
                    0f to teal.copy(alpha = 0.45f * pulse),
                    0.18f to Color.Transparent,
                    0.8f to Color.Transparent,
                    1f to warm.copy(alpha = 0.40f * pulse),
                ),
                topLeft = Offset(0f, h * 0.35f),
                size = androidx.compose.ui.geometry.Size(w, h * 0.65f),
            )
        }
    }
}

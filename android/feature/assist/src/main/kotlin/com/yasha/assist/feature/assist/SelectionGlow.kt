package com.yasha.assist.feature.assist

import android.graphics.RuntimeShader
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.drawscope.Stroke
import com.yasha.assist.core.capture.RectFrac
import com.yasha.assist.core.design.BrandGradient
import kotlin.math.min
import kotlin.math.sin
import kotlinx.coroutines.isActive

// Gemini-style selection glow: animated colored waves hugging the rounded-rect
// border of the crop region (teal/blue up top, warm on the right, green below).
private const val SELECTION_RING_AGSL = """
    uniform float2 resolution;
    uniform float4 rect;
    uniform float time;
    half4 main(float2 c) {
        float2 ctr = (rect.xy + rect.zw) * 0.5;
        float2 half = (rect.zw - rect.xy) * 0.5;
        float rad = min(28.0, min(half.x, half.y));
        float2 q = abs(c - ctr) - (half - float2(rad));
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
        float ang = atan(c.y - ctr.y, c.x - ctr.x);
        float w1 = sin(ang * 3.0 - time * 2.1) * 0.5 + 0.5;
        float w2 = sin(ang * 5.0 + time * 1.5 + 2.0) * 0.5 + 0.5;
        float below = smoothstep(-0.2, 0.8, sin(ang));
        float right = smoothstep(0.1, 0.9, cos(ang));
        float3 teal = float3(0.11, 0.72, 0.98);
        float3 blue = float3(0.24, 0.44, 1.0);
        float3 green = float3(0.36, 0.92, 0.42);
        float3 warm = float3(1.0, 0.33, 0.42);
        float3 col = mix(mix(teal, blue, w2), green, below * 0.85);
        col = mix(col, warm, right * (0.45 + 0.55 * w1));
        float band = exp(-pow((d - 12.0) / 34.0, 2.0));
        float halo = exp(-pow((d - 8.0) / 85.0, 2.0)) * 0.55;
        float inten = (band * (0.55 + 0.45 * w1) + halo * w2) * 1.9;
        float a = clamp(inten, 0.0, 1.0);
        return half4(half3(col * a), a);
    }
"""

@Composable
fun SelectionGlow(rect: RectFrac, modifier: Modifier = Modifier) {
    var time by remember { mutableFloatStateOf(0f) }
    val shader = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching { RuntimeShader(SELECTION_RING_AGSL) }.getOrNull()
        } else {
            null
        }
    }
    LaunchedEffect(Unit) {
        var first = -1L
        while (isActive) {
            withFrameNanos { now ->
                if (first < 0) first = now
                time = (now - first) / 1_000_000_000f
            }
        }
    }
    Canvas(modifier) {
        val l = rect.left * size.width
        val t = rect.top * size.height
        val r = rect.right * size.width
        val b = rect.bottom * size.height
        val region = Rect(l, t, r, b)
        if (shader != null) {
            shader.setFloatUniform("resolution", size.width, size.height)
            shader.setFloatUniform("rect", l, t, r, b)
            shader.setFloatUniform("time", time)
            drawRect(brush = ShaderBrush(shader))
        } else {
            // Static fallback: layered sweep-gradient rings in brand colors.
            val corner = min(28f, min((r - l) / 3f, (b - t) / 3f))
            val radii = CornerRadius(corner, corner)
            val waves = 0.7f + 0.3f * sin(time * 2.4f)
            listOf(26f to 0.14f, 14f to 0.35f, 5f to 0.9f).forEach { (w, a) ->
                drawRoundRect(
                    brush = Brush.sweepGradient(BrandGradient, Offset(region.center.x, region.center.y)),
                    topLeft = region.topLeft,
                    size = Size(region.width, region.height),
                    cornerRadius = radii,
                    alpha = a * waves,
                    style = Stroke(width = w),
                )
            }
        }
    }
}

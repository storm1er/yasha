package com.yasha.assist.core.capture

// Pure crop math: percentage rect (left,top,right,bottom in 0..1) → pixel crop,
// clamped and min-sized. Unit-tested on the JVM (no android.* deps).
data class PixelRect(val left: Int, val top: Int, val width: Int, val height: Int) {
    val right get() = left + width
    val bottom get() = top + height
}

object CropMath {
    const val MIN_PX = 32

    fun toPixels(rect: RectFrac, width: Int, height: Int): PixelRect {
        val l = (rect.left.coerceIn(0f, 1f) * width).toInt().coerceIn(0, width - 1)
        val t = (rect.top.coerceIn(0f, 1f) * height).toInt().coerceIn(0, height - 1)
        val r = (rect.right.coerceIn(0f, 1f) * width).toInt().coerceIn(l + 1, width)
        val b = (rect.bottom.coerceIn(0f, 1f) * height).toInt().coerceIn(t + 1, height)
        val w = (r - l).coerceAtLeast(MIN_PX).coerceAtMost(width - l)
        val h = (b - t).coerceAtLeast(MIN_PX).coerceAtMost(height - t)
        return PixelRect(l, t, w, h)
    }
}

data class RectFrac(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top

    fun withEdges(l: Float = left, t: Float = top, r: Float = right, b: Float = bottom) =
        RectFrac(minOf(l, r - 0.02f).coerceAtLeast(0f), minOf(t, b - 0.02f).coerceAtLeast(0f),
                 maxOf(r, l + 0.02f).coerceAtMost(1f), maxOf(b, t + 0.02f).coerceAtMost(1f))
}

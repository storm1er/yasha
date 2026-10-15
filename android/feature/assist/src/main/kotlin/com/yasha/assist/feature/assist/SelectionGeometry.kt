package com.yasha.assist.feature.assist

import com.yasha.assist.core.capture.RectFrac
import kotlin.math.max
import kotlin.math.min

// Circle-to-ask geometry (PLAN.md §M3): a freehand stroke becomes a clamped
// bounding box (normalized fractions), adjustable via 8 handles (4 corners + 4 edges).
object SelectionGeometry {
    const val MIN_PCT = 0.05f
    const val MAX_PCT = 1f

    fun boundsFromStroke(points: List<Pair<Float, Float>>, screenW: Int, screenH: Int): RectFrac? {
        if (points.isEmpty() || screenW <= 0 || screenH <= 0) return null
        var minX = Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE
        var maxY = -Float.MAX_VALUE
        for ((x, y) in points) {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
        fun clampPct(v: Float, dim: Int) = (v / dim).coerceIn(0f, MAX_PCT)
        var l = clampPct(minX, screenW)
        var r = clampPct(maxX, screenW)
        var t = clampPct(minY, screenH)
        var b = clampPct(maxY, screenH)
        if (r - l < MIN_PCT) {
            val c = ((l + r) / 2).coerceIn(0f, MAX_PCT)
            l = (c - MIN_PCT / 2).coerceAtLeast(0f)
            r = (c + MIN_PCT / 2).coerceAtMost(MAX_PCT)
        }
        if (b - t < MIN_PCT) {
            val c = ((t + b) / 2).coerceIn(0f, MAX_PCT)
            t = (c - MIN_PCT / 2).coerceAtLeast(0f)
            b = (c + MIN_PCT / 2).coerceAtMost(MAX_PCT)
        }
        return RectFrac(l, t, r, b)
    }
}

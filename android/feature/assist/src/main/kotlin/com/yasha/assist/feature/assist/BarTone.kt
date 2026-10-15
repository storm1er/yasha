package com.yasha.assist.feature.assist

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect

// Some OEMs (OOS15 confirmed) blank out the status-bar and navigation-bar strips
// of accessibility screenshots, which the floaty would render as black bars.
// Refill those strips by stretching the adjacent shot rows when (and only when)
// the shot really shows a black strip there.
object ShotFrame {
    private const val BLACK_LUMA = 8f

    /** Repaired shot; identity when nothing changed. */
    fun repair(shot: Bitmap, topPx: Int, bottomPx: Int): Bitmap {
        val maxBand = (shot.height * 0.12f).toInt()
        val top = topPx.coerceIn(0, maxBand)
        val bottom = bottomPx.coerceIn(0, maxBand)
        val topBlack = top > 0 && isBlackStrip(shot, 0, top)
        val bottomBlack = bottom > 0 && isBlackStrip(shot, shot.height - bottom, shot.height)
        if (!topBlack && !bottomBlack) return shot
        if (isWritable(shot)) {
            if (topBlack) stretchRow(shot, top, 0, top)
            if (bottomBlack) stretchRow(shot, shot.height - bottom - 1, shot.height - bottom, shot.height)
            return shot
        }
        // Screenshots can be hardware-backed and reject pixel writes despite
        // isMutable — fall back to a software copy painted via Canvas.
        val out = try {
            Bitmap.createBitmap(shot.width, shot.height, Bitmap.Config.ARGB_8888)
        } catch (_: OutOfMemoryError) {
            return shot
        }
        val canvas = Canvas(out)
        canvas.drawBitmap(shot, 0f, 0f, null)
        val w = shot.width
        val h = shot.height
        if (topBlack) canvas.drawBitmap(shot, Rect(0, top, w, top + 1), Rect(0, 0, w, top), null)
        if (bottomBlack) canvas.drawBitmap(shot, Rect(0, h - bottom - 1, w, h - bottom), Rect(0, h - bottom, w, h), null)
        return out
    }

    private fun isWritable(bitmap: Bitmap): Boolean =
        runCatching { bitmap.setPixel(0, 0, bitmap.getPixel(0, 0)) }.isSuccess

    private fun stretchRow(shot: Bitmap, srcY: Int, y0: Int, y1: Int) {
        val row = IntArray(shot.width) { shot.getPixel(it, srcY) }
        var y = y0
        while (y < y1) {
            for (x in row.indices) shot.setPixel(x, y, row[x])
            y++
        }
    }

    fun isBlackStrip(shot: Bitmap, y0: Int, y1: Int): Boolean {
        if (y1 <= y0) return false
        val stepX = (shot.width / 48).coerceAtLeast(1)
        val stepY = ((y1 - y0) / 8).coerceAtLeast(1)
        var sum = 0f
        var n = 0
        var y = y0
        while (y < y1) {
            var x = 0
            while (x < shot.width) {
                sum += luma(shot.getPixel(x, y))
                n++
                x += stepX
            }
            y += stepY
        }
        return n > 0 && sum / n < BLACK_LUMA
    }

    private fun luma(c: Int) =
        0.299f * (c shr 16 and 0xFF) + 0.587f * (c shr 8 and 0xFF) + 0.114f * (c and 0xFF)
}

// The frozen shot is the very screen that was under the system bars, so the bars'
// icon contrast should follow the shot's own brightness: sample the top strip
// (status bar) and bottom strip (nav bar) and use dark icons where it is light.
object BarTone {
    fun isLight(colors: IntArray, threshold: Float = 0.6f): Boolean {
        if (colors.isEmpty()) return false
        var sum = 0f
        for (c in colors) {
            val r = (c shr 16 and 0xFF) / 255f
            val g = (c shr 8 and 0xFF) / 255f
            val b = (c and 0xFF) / 255f
            sum += 0.299f * r + 0.587f * g + 0.114f * b
        }
        return sum / colors.size > threshold
    }

    fun sample(bitmap: Bitmap, fromTop: Boolean, frac: Float = 0.08f): IntArray {
        val band = (bitmap.height * frac).toInt().coerceAtLeast(1)
        val y0 = if (fromTop) 0 else (bitmap.height - band).coerceAtLeast(0)
        val stepX = (bitmap.width / 64).coerceAtLeast(1)
        val stepY = (band / 8).coerceAtLeast(1)
        val out = ArrayList<Int>()
        var y = y0
        while (y < (y0 + band).coerceAtMost(bitmap.height)) {
            var x = 0
            while (x < bitmap.width) {
                out += bitmap.getPixel(x, y)
                x += stepX
            }
            y += stepY
        }
        return out.toIntArray()
    }
}

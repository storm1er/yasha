package com.yasha.assist.feature.assist

import android.graphics.Bitmap
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BarToneTest {
    private fun gray(v: Int) = 0xFF000000.toInt() or (v shl 16) or (v shl 8) or v

    @Test
    fun emptyStripIsNotLight() {
        assertFalse(BarTone.isLight(intArrayOf()))
    }

    @Test
    fun blackStripIsNotLight() {
        assertFalse(BarTone.isLight(intArrayOf(0xFF000000.toInt(), gray(10), gray(30))))
    }

    @Test
    fun whiteStripIsLight() {
        assertTrue(BarTone.isLight(intArrayOf(0xFFFFFFFF.toInt(), gray(250))))
    }

    @Test
    fun midGrayFallsBelowThreshold() {
        assertFalse(BarTone.isLight(intArrayOf(gray(128))))
        assertTrue(BarTone.isLight(intArrayOf(gray(200))))
    }

    @Test
    fun sampleTopAndBottomBands() {
        val shot = Bitmap.createBitmap(200, 400, Bitmap.Config.ARGB_8888)
        shot.eraseColor(0xFF000000.toInt())
        for (y in 300 until 400) for (x in 0 until 200) shot.setPixel(x, y, 0xFFFFFFFF.toInt())
        assertFalse(BarTone.isLight(BarTone.sample(shot, fromTop = true)))
        assertTrue(BarTone.isLight(BarTone.sample(shot, fromTop = false)))
    }

    @Test
    fun sampleHandlesTinyBitmaps() {
        val tiny = Bitmap.createBitmap(2, 3, Bitmap.Config.ARGB_8888)
        tiny.eraseColor(0xFFFFFFFF.toInt())
        assertTrue(BarTone.isLight(BarTone.sample(tiny, fromTop = true)))
        assertTrue(BarTone.isLight(BarTone.sample(tiny, fromTop = false)))
    }
}

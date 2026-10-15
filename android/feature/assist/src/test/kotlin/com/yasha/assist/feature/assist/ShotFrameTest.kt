package com.yasha.assist.feature.assist

import android.graphics.Bitmap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ShotFrameTest {
    private fun shot(withTopBar: Boolean, withBottomBar: Boolean): Bitmap {
        val b = Bitmap.createBitmap(100, 200, Bitmap.Config.ARGB_8888)
        b.eraseColor(0xFF00FF00.toInt()) // content: green
        if (withTopBar) for (y in 0 until 20) for (x in 0 until 100) b.setPixel(x, y, 0xFF000000.toInt())
        if (withBottomBar) for (y in 180 until 200) for (x in 0 until 100) b.setPixel(x, y, 0xFF000000.toInt())
        return b
    }

    @Test
    fun repairsBlankedBarsByStretchingAdjacentRows() {
        val b = shot(withTopBar = true, withBottomBar = true)
        b.setPixel(50, 20, 0xFFFF0000.toInt()) // content row under the top strip
        b.setPixel(50, 179, 0xFF0000FF.toInt()) // content row above the bottom strip
        val fixed = ShotFrame.repair(b, topPx = 20, bottomPx = 20)
        assertSame(b, fixed) // software bitmaps are repaired in place
        assertEquals(0xFFFF0000.toInt(), fixed.getPixel(50, 0))
        assertEquals(0xFFFF0000.toInt(), fixed.getPixel(50, 19))
        assertEquals(0xFF0000FF.toInt(), fixed.getPixel(50, 199))
        assertEquals(0xFF0000FF.toInt(), fixed.getPixel(50, 180))
        // untouched content rows stay
        assertEquals(0xFF00FF00.toInt(), fixed.getPixel(50, 100))
    }

    @Test
    fun leavesRealContentUnderTheBarsUntouched() {
        val b = shot(withTopBar = false, withBottomBar = false)
        ShotFrame.repair(b, topPx = 20, bottomPx = 20)
        assertEquals(0xFF00FF00.toInt(), b.getPixel(50, 0))
        assertEquals(0xFF00FF00.toInt(), b.getPixel(50, 199))
    }

    @Test
    fun clampsAbsurdBandHeights() {
        val b = shot(withTopBar = true, withBottomBar = true)
        ShotFrame.repair(b, topPx = 100000, bottomPx = 100000)
        val maxBand = (200 * 0.12f).toInt()
        assertFalse(ShotFrame.isBlackStrip(b, 0, maxBand))
        assertFalse(ShotFrame.isBlackStrip(b, 200 - maxBand, 200))
    }

    @Test
    fun zeroBandsAreNoOps() {
        val b = shot(withTopBar = true, withBottomBar = true)
        ShotFrame.repair(b, topPx = 0, bottomPx = 0)
        assertTrue(ShotFrame.isBlackStrip(b, 0, 20))
    }

    @Test
    fun emptyStripIsNotBlack() {
        assertFalse(ShotFrame.isBlackStrip(shot(true, true), 5, 5))
    }
}

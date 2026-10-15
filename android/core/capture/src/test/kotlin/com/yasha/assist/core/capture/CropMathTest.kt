package com.yasha.assist.core.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CropMathTest {
    @Test
    fun `fractional rect maps to pixels`() {
        val px = CropMath.toPixels(RectFrac(0.1f, 0.2f, 0.5f, 0.6f), 1000, 2000)
        assertEquals(100, px.left)
        assertEquals(400, px.top)
        assertEquals(400, px.width)
        assertEquals(800, px.height)
    }

    @Test
    fun `clamps out-of-range fractions`() {
        val px = CropMath.toPixels(RectFrac(-0.5f, -0.5f, 1.5f, 1.5f), 800, 600)
        assertEquals(0, px.left)
        assertEquals(0, px.top)
        assertEquals(800, px.right)
        assertEquals(600, px.bottom)
    }

    @Test
    fun `degenerate rect still yields the minimum area`() {
        val px = CropMath.toPixels(RectFrac(0.5f, 0.5f, 0.5f, 0.5f), 1000, 1000)
        assertEquals(CropMath.MIN_PX, px.width)
        assertEquals(CropMath.MIN_PX, px.height)
        assertTrue(px.right <= 1000 && px.bottom <= 1000)
    }

    @Test
    fun `minimum near the edge does not overflow`() {
        val px = CropMath.toPixels(RectFrac(0.995f, 0.995f, 0.996f, 0.996f), 1000, 1000)
        assertTrue(px.right <= 1000)
        assertTrue(px.bottom <= 1000)
        assertTrue(px.width >= 1 && px.height >= 1)
    }
}

class RectFracTest {
    @Test
    fun `withEdges normalizes inverted drags`() {
        val r = RectFrac(0.5f, 0.5f, 0.8f, 0.8f).withEdges(l = 0.9f, t = 0.9f)
        assertTrue(r.left < r.right)
        assertTrue(r.top < r.bottom)
    }

    @Test
    fun `withEdges enforces minimum width`() {
        val r = RectFrac(0.1f, 0.1f, 0.9f, 0.9f).withEdges(r = 0.101f)
        assertTrue(r.right - r.left >= 0.02f - 1e-5f)
    }
}

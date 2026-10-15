package com.yasha.assist.feature.assist

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SelectionGeometryTest {
    @Test
    fun `empty stroke or zero dims give null`() {
        assertNull(SelectionGeometry.boundsFromStroke(emptyList(), 100, 100))
        assertNull(SelectionGeometry.boundsFromStroke(listOf(1f to 1f), 0, 100))
        assertNull(SelectionGeometry.boundsFromStroke(listOf(1f to 1f), 100, 0))
    }

    @Test
    fun `stroke maps to normalized bbox`() {
        val pts = listOf(10f to 20f, 110f to 220f, 60f to 100f)
        val rect = SelectionGeometry.boundsFromStroke(pts, 1000, 1000)!!
        assertEquals(0.01f, rect.left, 1e-5f)
        assertEquals(0.02f, rect.top, 1e-5f)
        assertEquals(0.11f, rect.right, 1e-5f)
        assertEquals(0.22f, rect.bottom, 1e-5f)
    }

    @Test
    fun `degenerate point expands to the minimum size`() {
        val rect = SelectionGeometry.boundsFromStroke(listOf(500f to 500f), 1000, 1000)!!
        assertEquals(SelectionGeometry.MIN_PCT, rect.width, 1e-4f)
        assertEquals(SelectionGeometry.MIN_PCT, rect.height, 1e-4f)
    }

    @Test
    fun `out-of-bounds points clamp to the screen`() {
        val rect = SelectionGeometry.boundsFromStroke(listOf(-50f to -10f, 2000f to 4000f), 1000, 1000)!!
        assertEquals(0f, rect.left, 1e-6f)
        assertEquals(0f, rect.top, 1e-6f)
        assertEquals(1f, rect.right, 1e-6f)
        assertEquals(1f, rect.bottom, 1e-6f)
    }

    @Test
    fun `point near the right edge keeps expansion inside the screen`() {
        val rect = SelectionGeometry.boundsFromStroke(listOf(999f to 1f), 1000, 1000)!!
        assertEquals(1f, rect.right, 1e-6f)
        assertEquals(0.974f, rect.left, 1e-3f)
    }
}

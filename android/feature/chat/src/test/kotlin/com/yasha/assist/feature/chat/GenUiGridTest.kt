package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.GenUiNode
import org.junit.Assert.assertEquals
import org.junit.Test

/** Grid reflow math (issue #43): the AI's `cols` is an upper bound, cells are
 *  never narrower than [minGridCellDp]. Pure function — no Compose runtime. */
class GenUiGridTest {
    private val metric = GenUiNode.Metric("Rev", "1", null, null)
    private val table = GenUiNode.Table(listOf("a", "b"), listOf(listOf("1", "2")))
    private val light = listOf(metric, metric)
    private val mixed = listOf(metric, table)

    @Test
    fun `phone width stacks heavy children in one column`() {
        assertEquals(1, effectiveGridCols(3, mixed, 360f))
    }

    @Test
    fun `phone width keeps light children two-up`() {
        assertEquals(2, effectiveGridCols(4, light, 360f))
    }

    @Test
    fun `tablet width honors up to four heavy columns`() {
        assertEquals(3, effectiveGridCols(3, mixed, 800f))
        assertEquals(4, effectiveGridCols(4, light, 800f))
    }

    @Test
    fun `declared columns are never exceeded`() {
        assertEquals(2, effectiveGridCols(2, light, 2000f))
    }

    @Test
    fun `never returns less than one column`() {
        assertEquals(1, effectiveGridCols(3, light, 40f))
    }

    @Test
    fun `cell floor distinguishes heavy from light content`() {
        assertEquals(150f, minGridCellDp(light), 0f)
        assertEquals(260f, minGridCellDp(mixed), 0f)
    }
}

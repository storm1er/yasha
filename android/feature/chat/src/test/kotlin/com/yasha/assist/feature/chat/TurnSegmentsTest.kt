package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.PartDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TurnSegmentsTest {
    private fun tool(name: String, status: String = "done") = UiTool("srv", name, status)

    @Test
    fun `stored parts null or empty means no segments`() {
        assertNull(TurnSegments.fromStored(null, emptyList()))
        assertNull(TurnSegments.fromStored(emptyList(), listOf(tool("a"))))
    }

    @Test
    fun `stored parts consume the flat tool list in order`() {
        val tools = listOf(tool("a"), tool("b"))
        val segs = TurnSegments.fromStored(
            listOf(
                PartDto("text", text = "Lead. "),
                PartDto("tools", count = 2),
                PartDto("text", text = "Done."),
            ),
            tools,
        )
        assertEquals(
            listOf(UiSegment.Text("Lead. "), UiSegment.Tools(tools), UiSegment.Text("Done.")),
            segs,
        )
    }

    @Test
    fun `stored parts slice tools per round`() {
        val a = tool("a")
        val b = tool("b")
        val segs = TurnSegments.fromStored(
            listOf(
                PartDto("tools", count = 1),
                PartDto("text", text = "mid"),
                PartDto("tools", count = 1),
            ),
            listOf(a, b),
        )
        assertEquals(
            listOf(UiSegment.Tools(listOf(a)), UiSegment.Text("mid"), UiSegment.Tools(listOf(b))),
            segs,
        )
    }

    @Test
    fun `malformed stored parts fall back to null`() {
        val tools = listOf(tool("a"))
        assertNull(TurnSegments.fromStored(listOf(PartDto("nope")), tools)) // unknown type
        assertNull(TurnSegments.fromStored(listOf(PartDto("text")), tools)) // text part without text
        assertNull(TurnSegments.fromStored(listOf(PartDto("tools", count = 2)), tools)) // not enough tools
        assertNull(TurnSegments.fromStored(listOf(PartDto("tools", count = -1)), tools)) // negative count
        // Leftover tools after the last part ⇒ counts don't line up.
        assertNull(TurnSegments.fromStored(listOf(PartDto("tools", count = 1)), listOf(tool("a"), tool("b"))))
    }

    @Test
    fun `appendText extends the trailing text segment or opens one`() {
        assertEquals(listOf(UiSegment.Text("ab")), TurnSegments.appendText(listOf(UiSegment.Text("a")), "b"))
        assertEquals(listOf(UiSegment.Text("x")), TurnSegments.appendText(emptyList(), "x"))
        val segs = listOf(UiSegment.Text("a"), UiSegment.Tools(listOf(tool("x"))))
        assertEquals(segs + UiSegment.Text(" new"), TurnSegments.appendText(segs, " new"))
    }

    @Test
    fun `applyTool replaces its running chip inside the trailing round`() {
        val running = tool("x", "running")
        val done = tool("x", "done")
        val segs = listOf(UiSegment.Text("t"), UiSegment.Tools(listOf(tool("w"), running)))
        assertEquals(
            listOf(UiSegment.Text("t"), UiSegment.Tools(listOf(tool("w"), done))),
            TurnSegments.applyTool(segs, done),
        )
    }

    @Test
    fun `applyTool after text starts a new tools segment`() {
        val segs = listOf(UiSegment.Text("t"))
        assertEquals(
            listOf(UiSegment.Text("t"), UiSegment.Tools(listOf(tool("x", "running")))),
            TurnSegments.applyTool(segs, tool("x", "running")),
        )
    }

    @Test
    fun `applyTool with no running match appends to the trailing round`() {
        val segs = listOf(UiSegment.Tools(listOf(tool("w", "done"))))
        assertEquals(
            listOf(UiSegment.Tools(listOf(tool("w", "done"), tool("x", "running")))),
            TurnSegments.applyTool(segs, tool("x", "running")),
        )
    }

    // ── tier-1 generative cards (issue 30) ──────────────────────────────────

    private fun card(id: String) = UiSegment.Card(id, listOf(com.yasha.assist.core.net.GenUiNode.Text(id)))

    @Test
    fun `stored parts interleave cards and consume the flat card list`() {
        val segs = TurnSegments.fromStored(
            listOf(
                PartDto("text", text = "Lead. "),
                PartDto("card"),
                PartDto("text", text = "Tail."),
            ),
            emptyList(),
            listOf(card("c1")),
        )
        assertEquals(
            listOf(UiSegment.Text("Lead. "), card("c1"), UiSegment.Text("Tail.")),
            segs,
        )
    }

    @Test
    fun `stored parts mismatch on cards falls back (orphan part or leftover card)`() {
        assertNull(TurnSegments.fromStored(listOf(PartDto("card")), emptyList(), emptyList()))
        assertNull(TurnSegments.fromStored(listOf(PartDto("text", text = "x")), emptyList(), listOf(card("c1"))))
    }

    @Test
    fun `appendCard adds its own segment after text and chips`() {
        val segs = listOf(UiSegment.Text("Look: "), UiSegment.Tools(listOf(tool("x"))))
        assertEquals(
            segs + card("c9"),
            TurnSegments.appendCard(segs, card("c9")),
        )
    }
}

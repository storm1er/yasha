package com.yasha.assist.feature.assist

import org.junit.Assert.assertEquals
import org.junit.Test

class AskToolUpsertTest {
    @Test
    fun `appends then upserts by server and name`() {
        val started = emptyList<AskTool>().upsertTool("ketch", "search", "running")
        val done = started.upsertTool("ketch", "search", "done")
        val second = done.upsertTool("ketch", "crawl", "running")
        assertEquals(listOf(AskTool("ketch", "search", "done")), done)
        assertEquals(
            listOf(AskTool("ketch", "search", "done"), AskTool("ketch", "crawl", "running")),
            second,
        )
    }

    @Test
    fun `upsert keeps the truncation flag (issue 8)`() {
        val started = emptyList<AskTool>().upsertTool("ketch", "search", "running")
        val done = started.upsertTool("ketch", "search", "done", truncated = true)
        assertEquals(listOf(AskTool("ketch", "search", "done", truncated = true)), done)
    }
}

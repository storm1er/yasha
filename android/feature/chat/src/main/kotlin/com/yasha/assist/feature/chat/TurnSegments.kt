package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.PartDto

/** Ordered rendering segments of one assistant turn (issue #7): tool chips
 *  interleaved with the surrounding text in execution order. */
sealed interface UiSegment {
    data class Text(val text: String) : UiSegment
    data class Tools(val tools: List<UiTool>) : UiSegment
}

object TurnSegments {
    /** Stored `meta.parts` + flat tool chips → ordered segments; null when
     *  absent or malformed (legacy rows keep rendering chips above the text).
     *  A "tools" part consumes the next `count` entries of the flat list. */
    fun fromStored(parts: List<PartDto>?, tools: List<UiTool>): List<UiSegment>? {
        if (parts == null || parts.isEmpty()) return null
        val out = ArrayList<UiSegment>(parts.size)
        var i = 0
        for (p in parts) {
            when (p.type) {
                "text" -> {
                    val t = p.text ?: return null
                    out.add(UiSegment.Text(t))
                }
                "tools" -> {
                    if (p.count < 0 || i + p.count > tools.size) return null
                    out.add(UiSegment.Tools(tools.subList(i, i + p.count).toList()))
                    i += p.count
                }
                else -> return null
            }
        }
        return if (i == tools.size) out else null
    }

    /** Live SSE: a text delta extends the trailing text segment or opens one
     *  (a chip in between ended the previous segment). */
    fun appendText(segments: List<UiSegment>, delta: String): List<UiSegment> {
        val last = segments.lastOrNull()
        return if (last is UiSegment.Text) {
            segments.dropLast(1) + UiSegment.Text(last.text + delta)
        } else {
            segments + UiSegment.Text(delta)
        }
    }

    /** Live SSE: terminal events replace their running chip inside the
     *  trailing tools segment; a chip after text starts a new round. */
    fun applyTool(segments: List<UiSegment>, tool: UiTool): List<UiSegment> {
        val last = segments.lastOrNull()
        if (last is UiSegment.Tools) {
            val idx = last.tools.indexOfLast {
                it.status == "running" && it.server == tool.server && it.name == tool.name
            }
            val updated = last.tools.toMutableList()
            if (idx >= 0) updated[idx] = tool else updated.add(tool)
            return segments.dropLast(1) + UiSegment.Tools(updated)
        }
        return segments + UiSegment.Tools(listOf(tool))
    }
}

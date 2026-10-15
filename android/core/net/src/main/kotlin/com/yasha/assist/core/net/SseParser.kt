package com.yasha.assist.core.net

// Minimal SSE frame accumulator matching the server's `data: {json}\n\n` framing
// (app/api/chat/route.ts). Feed raw chunk text, get whole payloads out.
class SseParser {
    private var buffer = StringBuilder()

    fun append(chunk: String): List<String> {
        buffer.append(chunk.replace("\r\n", "\n"))
        val payloads = mutableListOf<String>()
        var idx: Int
        while (true) {
            idx = buffer.indexOf("\n\n")
            if (idx < 0) break
            val frame = buffer.substring(0, idx)
            buffer.delete(0, idx + 2)
            frame.lineSequence()
                .map { it.trimEnd('\r') }
                .filter { it.startsWith("data:") }
                .map { it.removePrefix("data:").removePrefix(" ").trim() }
                .filter { it.isNotEmpty() && it != "[DONE]" }
                .forEach { payloads.add(it) }
        }
        return payloads
    }
}

package com.yasha.assist.core.net

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SseParserTest {
    @Test
    fun `single frame split across chunks`() {
        val p = SseParser()
        assertTrue(p.append("data: {\"thread").isEmpty())
        val out = p.append("Id\":\"abc\"}\n\n")
        assertEquals(listOf("{\"threadId\":\"abc\"}"), out)
    }

    @Test
    fun `crlf framing and trailing partial kept`() {
        val p = SseParser()
        val out = p.append("data: one\r\n\r\ndata: two\r\n\r\ndata: thr")
        assertEquals(listOf("one", "two"), out)
        assertEquals(listOf("three"), p.append("ee\r\n\r\n"))
    }

    @Test
    fun `comments skipped, done sentinel passed through`() {
        val p = SseParser()
        val out = p.append(": ping\ndata:\ndata: [DONE]\ndata: {\"c\":\"x\"}\n\n")
        assertEquals(listOf("[DONE]", "{\"c\":\"x\"}"), out)
    }
}

class ChatEventsTest {
    @Test
    fun `maps the protocol v2 frames`() {
        // Wire shapes as emitted by lib/chat/stream.ts (captured via curl).
        assertEquals(
            ChatEvent.ThreadId("t1"),
            ChatEvents.parse("""{"type":"data-thread","data":{"threadId":"t1"}}"""),
        )
        assertEquals(
            ChatEvent.Delta("HELLO"),
            ChatEvents.parse("""{"type":"text-delta","id":"t0","delta":"HELLO"}"""),
        )
        assertEquals(ChatEvent.Done(false), ChatEvents.parse("[DONE]"))
        assertEquals(ChatEvent.Failure("upstream_stream"), ChatEvents.parse("""{"type":"data-error","data":{"code":"upstream_stream"}}"""))
        assertEquals(
            ChatEvent.ToolProgress("ketch", "search", "done"),
            ChatEvents.parse("""{"type":"data-tool","data":{"server":"ketch","name":"search","status":"done"}}"""),
        )
    }

    @Test
    fun `bookkeeping chunks carry no app event`() {
        assertNull(ChatEvents.parse("""{"type":"start"}"""))
        assertNull(ChatEvents.parse("""{"type":"text-start","id":"t0"}"""))
        assertNull(ChatEvents.parse("""{"type":"text-end","id":"t0"}"""))
        assertNull(ChatEvents.parse("""{"type":"finish"}"""))
    }

    @Test
    fun `tool progress carries args and result`() {
        assertEquals(
            ChatEvent.ToolProgress("ketch", "search", "error", "{\"q\":\"x\"}", "tool error: boom"),
            ChatEvents.parse(
                """{"type":"data-tool","data":{"server":"ketch","name":"search","status":"error",""" +
                    """"args":"{\"q\":\"x\"}","result":"tool error: boom"}}""",
            ),
        )
    }

    @Test
    fun `tool progress carries the truncation flag (issue 8)`() {
        assertEquals(
            ChatEvent.ToolProgress("ketch", "search", "done", "{}", "…", truncated = true),
            ChatEvents.parse(
                """{"type":"data-tool","data":{"server":"ketch","name":"search","status":"done",""" +
                    """"args":"{}","result":"…","truncated":true}}""",
            ),
        )
        // Absent flag = not truncated: pre-issue events parse unchanged.
        val plain = ChatEvents.parse("""{"type":"data-tool","data":{"server":"k","name":"n","status":"done"}}""")
        assertEquals(false, (plain as ChatEvent.ToolProgress).truncated)
    }

    @Test
    fun `tool progress carries the generative card (issue 16)`() {
        assertEquals(
            ChatEvent.ToolProgress(
                "ketch", "weather", "done",
                card = CardDto(
                    kind = "weather",
                    title = "Nice day",
                    body = "Sunny",
                    fields = listOf(CardFieldDto("Wind", "12 km/h")),
                    links = listOf(CardLinkDto("Radar", "https://example.com/radar")),
                ),
            ),
            ChatEvents.parse(
                """{"type":"data-tool","data":{"server":"ketch","name":"weather","status":"done","card":{
                    "kind":"weather","title":"Nice day","body":"Sunny",
                    "fields":[{"label":"Wind","value":"12 km/h"}],
                    "links":[{"label":"Radar","url":"https://example.com/radar"}]}}}""",
            ),
        )
        // Defaults: kind falls back to info; no card = null (old servers).
        val minimal = ChatEvents.parse(
            """{"type":"data-tool","data":{"server":"k","name":"n","status":"done","card":{"title":"T"}}}""",
        ) as ChatEvent.ToolProgress
        assertEquals(CardDto(kind = "info", title = "T"), minimal.card)
        assertNull((ChatEvents.parse("""{"type":"data-tool","data":{"server":"k","name":"n","status":"done"}}""") as ChatEvent.ToolProgress).card)
        // A card without the required title degrades to a plain chip.
        val broken = ChatEvents.parse(
            """{"type":"data-tool","data":{"server":"k","name":"n","status":"done","card":{"body":"oops"}}}""",
        ) as ChatEvent.ToolProgress
        assertNull(broken.card)
    }

    @Test
    fun `garbage and malformed data parts map to null`() {
        assertNull(ChatEvents.parse("not json"))
        assertNull(ChatEvents.parse("[1,2]"))
        assertNull(ChatEvents.parse("""{"other":1}"""))
        // v1 shapes are dead: unknown type → null, never a silent event.
        assertNull(ChatEvents.parse("""{"threadId":"t1"}"""))
        assertNull(ChatEvents.parse("""{"c":"hi"}"""))
        assertNull(ChatEvents.parse("""{"done":true}"""))
        assertNull(ChatEvents.parse("""{"type":"data-thread"}"""))
        assertNull(ChatEvents.parse("""{"type":"data-error"}"""))
        assertNull(ChatEvents.parse("""{"type":"text-delta","id":"t0"}"""))
    }
}

class SessionStoreCookieTest {
    @Test
    fun `extracts the better-auth token from Set-Cookie headers`() {
        val headers = listOf(
            "other=1; Path=/",
            "better-auth.session_token=abc.DEF%3D; Path=/; Expires=Wed; HttpOnly; SameSite=Lax; Secure",
        )
        assertEquals("abc.DEF%3D", SessionStore.parseSessionCookie(headers))
        assertNull(SessionStore.parseSessionCookie(listOf("other=1")))
        assertNull(SessionStore.parseSessionCookie(listOf("better-auth.session_token=; Path=/")))
    }

    @Test
    fun `extracts the token from the __Secure- prefixed cookie (https servers)`() {
        val headers = listOf(
            "other=1; Path=/",
            "__Secure-better-auth.session_token=tok.SEC%3D; Path=/; HttpOnly; Secure; SameSite=Lax",
        )
        assertEquals("tok.SEC%3D", SessionStore.parseSessionCookie(headers))
        assertNull(SessionStore.parseSessionCookie(listOf("__Secure-other=1")))
    }

    @Test
    fun `cookie header carries the token under both cookie names`() {
        val header = SessionStore.cookieHeader("tok.123")
        assertTrue(header.contains("better-auth.session_token=tok.123"))
        assertTrue(header.contains("__Secure-better-auth.session_token=tok.123"))
    }
}

class ErrorCodeTest {
    @Test
    fun `maps http statuses to server error codes`() {
        assertEquals("unauthorized", YashaClient.errorCodeOf(401, "{}"))
        assertEquals("busy", YashaClient.errorCodeOf(429, "{\"error\":\"busy\"}"))
        assertEquals("no_model_configured", YashaClient.errorCodeOf(400, "{\"error\" : \"no_model_configured\"}"))
        assertEquals("http_500", YashaClient.errorCodeOf(500, "<html>boom</html>"))
    }
}

class EndpointsTest {
    @Test
    fun `trailing slashes normalized, paths match web routes`() {
        val e = YashaEndpoints("https://example.com/")
        assertEquals("https://example.com/api/chat", e.chat)
        assertEquals("https://example.com/api/auth/sign-in/email", e.signIn)
        assertEquals("https://example.com/api/auth/sign-in/username", e.signInUsername)
        assertEquals("https://example.com/api/threads", e.threads)
        assertEquals("https://example.com/api/audio/config", e.audioConfig)
        assertEquals("https://example.com/api/chat/messages/m1/transcribe", e.messageTranscribe("m1"))
        assertEquals("https://example.com/api/app/version", e.appVersion)
        assertEquals("https://example.com/api/app-update", e.appUpdate)
        assertEquals(1568, YashaEndpoints.ATTACHMENT_MAX_SIDE)
    }
}

class AppUpdateDtoTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `ready payload decodes link checksum and stamp`() {
        val dto = json.decodeFromString(
            AppUpdateDto.serializer(),
            """{"state":"ready","downloadUrl":"/d/abc","versionCode":3,"versionName":"0.3.0","sha256":"deadbeef","bytes":8123456}""",
        )
        assertEquals("ready", dto.state)
        assertEquals("/d/abc", dto.downloadUrl)
        assertEquals(3, dto.versionCode)
        assertEquals("0.3.0", dto.versionName)
        assertEquals("deadbeef", dto.sha256)
        assertEquals(8123456L, dto.bytes)
        assertNull(dto.error)
    }

    @Test
    fun `idle and failed payloads decode with defaults`() {
        assertEquals("idle", json.decodeFromString(AppUpdateDto.serializer(), """{"state":"idle"}""").state)
        val failed = json.decodeFromString(
            AppUpdateDto.serializer(),
            """{"state":"failed","error":"gradle_failed (exit 1): boom","versionCode":3}""",
        )
        assertEquals("gradle_failed (exit 1): boom", failed.error)
        assertEquals(3, failed.versionCode)
    }
}

class DownloadErrorTest {
    @Test
    fun `410 maps to expired, the rest like errorCodeOf`() {
        assertEquals("expired", YashaClient.downloadErrorOf(410, "<html>used</html>"))
        assertEquals("unauthorized", YashaClient.downloadErrorOf(401, ""))
        assertEquals("http_500", YashaClient.downloadErrorOf(500, "boom"))
    }
}

class ApkHashingTest {
    @Test
    fun `sha256 matches the known digest and null on missing files`() {
        val file = java.io.File.createTempFile("yasha-hash", ".bin")
        try {
            file.writeBytes("APKDATA".toByteArray())
            // echo -n APKDATA | sha256sum
            assertEquals("2ce76b4e9335982d523a05f17324d2c129e5e72b57b111d93a38a8c8689a9ed3", ApkHashing.sha256(file))
        } finally {
            file.delete()
        }
        assertNull(ApkHashing.sha256(java.io.File("/nope/missing.apk")))
    }
}

class AudioDtoTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `audio config parses the server payload with defaults`() {
        val dto = json.decodeFromString(
            AudioConfigDto.serializer(),
            """{"enabled":true,"model":"Gemma-4-E4B-it-GGUF","smartModel":"Gemma-4-26B-A4B-it-GGUF",
               "compatibleModels":["Gemma-4 E4B"],"smartAudioCapable":false,"maxAudioBytes":8388608}""",
        )
        assertTrue(dto.enabled)
        assertEquals("Gemma-4-E4B-it-GGUF", dto.model)
        assertEquals(listOf("Gemma-4 E4B"), dto.compatibleModels)
        assertEquals(8388608L, dto.maxAudioBytes)
        val sparse = json.decodeFromString(AudioConfigDto.serializer(), "{}")
        assertEquals(false, sparse.enabled)
        assertNull(sparse.model)
    }

    @Test
    fun `app version parses the server payload`() {
        val dto = json.decodeFromString(
            AppVersionDto.serializer(),
            """{"versionCode":2,"versionName":"0.2.9"}""",
        )
        assertEquals(2, dto.versionCode)
        assertEquals("0.2.9", dto.versionName)
    }

    @Test
    fun `attachment limits parses the server payload with defaults`() {
        val dto = json.decodeFromString(
            AttachmentLimitsDto.serializer(),
            """{"maxImagesPerMessage":2,"maxWindowImages":5,"maxUploadBytes":1048576}""",
        )
        assertEquals(2, dto.maxImagesPerMessage)
        assertEquals(5, dto.maxWindowImages)
        assertEquals(1048576L, dto.maxUploadBytes)
        val sparse = json.decodeFromString(AttachmentLimitsDto.serializer(), "{}")
        // Defaults mirror lib/settings.ts (chat.maxImagesPerMessage/…).
        assertEquals(4, sparse.maxImagesPerMessage)
        assertEquals(8, sparse.maxWindowImages)
        assertEquals(20971520L, sparse.maxUploadBytes)
    }

    @Test
    fun `chat body serializes protocol v3 (docs-slash-protocol-v3) minimal window`() {
        val body = chatRequestBody(
            text = "hi",
            threadId = null,
            attachments = ChatAttachments(images = listOf("data:image/png;base64,AAA"), audio = "data:audio/wav;base64,BBB"),
        )
        val out = Json { encodeDefaults = true; explicitNulls = false }
            .encodeToString(ChatRequestBody.serializer(), body)
        // Thread slot + single client-id'd user turn; no v2 keys leak.
        assertTrue(out.contains("\"id\":\"new\""))
        assertTrue(out.contains("\"role\":\"user\""))
        assertTrue(out.contains("\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]"))
        assertTrue(Regex("\"messages\":\\[\\{\"id\":\"[0-9a-fA-F-]{36}\"").containsMatchIn(out))
        assertTrue(out.contains("\"interactive\":false"))
        assertTrue(out.contains("\"cards\":false")) // floaty default; chat screen opts in
        assertTrue(out.contains("\"images\":[\"data:image/png;base64,AAA\"]"))
        assertTrue(out.contains("\"audio\":\"data:audio/wav;base64,BBB\""))
        assertTrue(!out.contains("threadId"))
        assertTrue(!out.contains("\"message\""))
        assertTrue(!out.contains("\"model\""))
        // Existing thread → its id in the same slot.
        val onThread = chatRequestBody(text = "", threadId = "th-9")
        val outThread = Json { encodeDefaults = true; explicitNulls = false }
            .encodeToString(ChatRequestBody.serializer(), onThread)
        assertTrue(outThread.contains("\"id\":\"th-9\""))
        assertTrue(outThread.contains("\"text\":\"\"")) // audio-only turn: empty text part
        // Card-capable surface (issue 30): cards=true alongside interactive=false.
        val cardBody = Json { encodeDefaults = true; explicitNulls = false }
            .encodeToString(ChatRequestBody.serializer(), chatRequestBody(text = "hi", threadId = null, cards = true))
        assertTrue(cardBody.contains("\"cards\":true"))
    }
}

class McpPrefsDtoTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parses follow-instance payload`() {
        val dto = json.decodeFromString(McpPrefsDto.serializer(), """{"userEnabled":null,"instanceEnabled":true}""")
        assertNull(dto.userEnabled)
        assertTrue(dto.instanceEnabled)
    }

    @Test
    fun `parses opted-out + instance-disabled and ignores unknown keys`() {
        val dto = json.decodeFromString(
            McpPrefsDto.serializer(),
            """{"userEnabled":false,"instanceEnabled":false,"extra":"x"}""",
        )
        assertTrue(dto.userEnabled == false)
        assertEquals(false, dto.instanceEnabled)
    }

    @Test
    fun `missing fields default to follow + enabled`() {
        val dto = json.decodeFromString(McpPrefsDto.serializer(), """{"instanceEnabled":true}""")
        assertNull(dto.userEnabled)
        assertTrue(dto.instanceEnabled)
    }
}

class McpAdminDtoTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parses full server rows`() {
        val dto = json.decodeFromString(
            McpAdminDto.serializer(),
            """{"ok":true,"mcpEnabled":false,"servers":[{"id":"k","builtin":true,"name":"k","url":null,"enabled":true,
              "headers":{"A":"••••"},"disabledTools":["x"],
              "health":{"ok":true,"toolCount":2,"error":null},
              "tools":[{"name":"search","description":"d"},{"name":"tag"}]}]}""",
        )
        assertEquals(false, dto.mcpEnabled)
        val s0 = dto.servers.single()
        assertEquals("k", s0.id)
        assertTrue(s0.builtin)
        assertNull(s0.url)
        assertEquals("••••", s0.headers?.get("A"))
        assertEquals(listOf("x"), s0.disabledTools)
        assertTrue(s0.health.ok)
        assertEquals(2, s0.health.toolCount)
        assertEquals("d", s0.tools[0].description)
        assertEquals("", s0.tools[1].description)
    }

    @Test
    fun `defaults for sparse payloads`() {
        val dto = json.decodeFromString(McpAdminDto.serializer(), """{"servers":[{"id":"r","name":"r","enabled":false}]}""")
        val s0 = dto.servers.single()
        assertEquals(false, dto.mcpEnabled)
        assertEquals(false, s0.builtin)
        assertEquals(McpHealthDto(), s0.health)
        assertTrue(s0.tools.isEmpty())
        assertNull(s0.owner)
    }

    @Test
    fun `parses the owner username on user-owned rows`() {
        val dto = json.decodeFromString(
            McpAdminDto.serializer(),
            """{"servers":[{"id":"u-1","name":"Mine","enabled":true,"owner":"alice"}]}""",
        )
        assertEquals("alice", dto.servers.single().owner)
    }
}

class McpUserServersDtoTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parses guardrail, quota and owner-scoped rows`() {
        val dto = json.decodeFromString(
            McpUserServersDto.serializer(),
            """{"ok":true,"serversEnabled":true,"maxServers":3,"servers":[
              {"id":"p-1","name":"Personal","url":"https://x.test/mcp","enabled":true,
               "headers":{"X-Key":"••••"},"disabledTools":["drop"],
               "health":{"ok":true,"toolCount":1,"error":null},
               "tools":[{"name":"echo","description":"echoes"}]}]}""",
        )
        assertTrue(dto.serversEnabled)
        assertEquals(3, dto.maxServers)
        val s0 = dto.servers.single()
        assertEquals("p-1", s0.id)
        assertEquals("https://x.test/mcp", s0.url)
        assertTrue(s0.enabled)
        assertEquals("••••", s0.headers?.get("X-Key"))
        assertEquals(listOf("drop"), s0.disabledTools)
        assertEquals(1, s0.health.toolCount)
        assertEquals("echoes", s0.tools.single().description)
    }

    @Test
    fun `sparse payload falls back to defaults and tolerates unknown keys`() {
        val dto = json.decodeFromString(
            McpUserServersDto.serializer(),
            """{"serversEnabled":false,"servers":[{"id":"a","name":"a","future":{"x":1}}]}""",
        )
        assertFalse(dto.serversEnabled)
        assertEquals(0, dto.maxServers)
        val s0 = dto.servers.single()
        assertFalse(s0.enabled)
        assertEquals(McpHealthDto(), s0.health)
        assertNull(s0.headers)
        assertTrue(s0.tools.isEmpty())
    }

    @Test
    fun `parses the oauth status block`() {
        val dto = json.decodeFromString(
            McpUserServersDto.serializer(),
            """{"servers":[{"id":"a","name":"a","url":"https://x/mcp",
               "oauth":{"configured":true,"authorized":false}}]}""",
        )
        val oauth = dto.servers.single().oauth
        assertTrue(oauth.configured)
        assertFalse(oauth.authorized)
    }

    @Test
    fun `needs_auth health code is parsed`() {
        val h = json.decodeFromString(McpHealthDto.serializer(), """{"ok":false,"toolCount":0,"error":"authorization_required","code":"needs_auth"}""")
        assertEquals("needs_auth", h.code)
        assertNull(McpHealthDto().code)
    }
}

class MessageMetaDtoTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parses the ordered turn parts`() {
        val meta = json.decodeFromString(
            MessageMetaDto.serializer(),
            """{"tools":[{"server":"s","name":"n","ok":true,"args":"{}","result":"r"}],
               "parts":[{"type":"text","text":"Lead. "},{"type":"tools","count":1},{"type":"text","text":"Done."}]}""",
        )
        assertEquals(
            listOf(
                PartDto("text", text = "Lead. "),
                PartDto("tools", count = 1),
                PartDto("text", text = "Done."),
            ),
            meta.parts,
        )
    }

    @Test
    fun `legacy rows without parts default to null`() {
        val meta = json.decodeFromString(
            MessageMetaDto.serializer(),
            """{"tools":[{"server":"s","name":"n","ok":true}]}""",
        )
        assertNull(meta.parts)
        assertEquals(1, meta.tools.size)
    }
}

// Tier-1 generative UI on Android (issue 30): data-card chunk mapping,
// defensive tree parsing and stored meta.cards decoding.
class GenUiWireTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `data-card maps to RenderCard (single node)`() {
        assertEquals(
            ChatEvent.RenderCard("c1", listOf(GenUiNode.Text("hi"))),
            ChatEvents.parse("""{"type":"data-card","data":{"id":"c1","root":{"type":"text","text":"hi"}}}"""),
        )
    }

    @Test
    fun `data-card array root stacks and skips malformed nodes inside`() {
        val ev = ChatEvents.parse(
            """{"type":"data-card","data":{"id":"c2","root":[
               {"type":"text","text":"a"},
               {"type":"bogus"},
               {"type":"metric","label":"L","value":7,"trend":"up"}]}}""",
        ) as ChatEvent.RenderCard
        assertEquals(
            listOf(GenUiNode.Text("a"), GenUiNode.Metric("L", "7", null, "up")),
            ev.nodes,
        )
    }

    @Test
    fun `data-card without id or with nothing parseable maps to null`() {
        assertNull(ChatEvents.parse("""{"type":"data-card","data":{"root":{"type":"text","text":"x"}}}"""))
        assertNull(ChatEvents.parse("""{"type":"data-card","data":{"id":"c","root":{"type":"nope"}}}"""))
        assertNull(ChatEvents.parse("""{"type":"data-card","data":{"id":"c"}}"""))
    }

    @Test
    fun `parser covers the full vocabulary with defensive defaults`() {
        val nodes = GenUiParser.parseRoot(
            json.parseToJsonElement(
                """[
                 {"type":"badge","text":"ok"},
                 {"type":"progress","value":142.5},
                 {"type":"list","items":["a","b"],"ordered":true},
                 {"type":"chart","chart":"bar","data":[{"label":"Mon","value":3},{"label":"Tue","value":null}]},
                 {"type":"table","columns":["A","B"],"rows":[["x",1],[]]},
                 {"type":"grid","cols":9,"children":[{"type":"text","text":"g"}]},
                 {"type":"card","title":"C","children":[{"type":"slides","slides":[{"title":"s","children":[{"type":"text","text":"in"}]}]}]},
                 {"type":"card","children":[]},
                 {"type":"chart","chart":"bar","data":[]}
               ]""",
            ),
        )
        assertEquals("ok" to "default", run { val b = nodes[0] as GenUiNode.Badge; b.text to b.tone })
        assertEquals(100f, (nodes[1] as GenUiNode.Progress).value) // clamped
        assertEquals(listOf("a", "b"), (nodes[2] as GenUiNode.BulletList).items)
        assertEquals(1, (nodes[3] as GenUiNode.Chart).data.size) // null-value point skipped
        assertEquals(1, (nodes[4] as GenUiNode.Table).rows.size) // empty row skipped
        assertEquals(4, (nodes[5] as GenUiNode.Grid).cols) // clamped to 1..4
        val card = nodes[6] as GenUiNode.Card
        val slides = card.children[0] as GenUiNode.Slides
        assertEquals("in", (slides.slides[0].children[0] as GenUiNode.Text).text)
        assertEquals(7, nodes.size) // empty card + empty chart dropped entirely
    }

    @Test
    fun `meta cards decode with the row`() {
        val meta = json.decodeFromString(
            MessageMetaDto.serializer(),
            """{"cards":[{"id":"c1","root":{"type":"text","text":"x"}}],"parts":[{"type":"card"}]}""",
        )
        assertEquals("c1", meta.cards.single().id)
        assertEquals(listOf(GenUiNode.Text("x")), GenUiParser.parseRoot(meta.cards.single().root))
    }
}

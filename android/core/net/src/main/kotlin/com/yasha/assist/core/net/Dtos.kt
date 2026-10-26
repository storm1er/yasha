package com.yasha.assist.core.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ModelsDto(
    val models: List<ModelDto>,
    val default: String? = null,
    val noVision: Boolean = false,
)

@Serializable
data class ModelDto(val id: String, val name: String? = null, val label: String? = null, val vision: Boolean? = null)

@Serializable
data class ThreadsDto(val threads: List<ThreadRowDto>)

@Serializable
data class ThreadRowDto(val threadId: String, val title: String, val updatedAt: String)

@Serializable
data class ThreadDetailDto(val thread: ThreadHeadDto, val messages: List<MessageDto>)

@Serializable
data class ThreadHeadDto(val threadId: String, val title: String, val model: String? = null)

@Serializable
data class MessageDto(
    val id: String,
    val role: String,
    val content: String,
    val createdAt: String,
    val meta: MessageMetaDto? = null,
)

@Serializable
data class MessageMetaDto(
    val images: List<String> = emptyList(),
    val tools: List<ToolMetaDto> = emptyList(),
    // Ordered text/tool interleaving of one assistant turn (issue #7): null on
    // legacy rows (render chips above the text); a "tools" part consumes the
    // next `count` entries of `tools` in execution order.
    val parts: List<PartDto>? = null,
    // Voice messages (AUDIO-REFACTO-PLAN): blob + background caption state.
    val audio: String? = null,
    val audioTranscript: String? = null,
    val audioTranscriptFailed: Boolean = false,
    // Server-annotated error code when the assistant turn for this user
    // message failed (e.g. "timeout") — renders the red retry notice.
    val error: String? = null,
)

@Serializable
data class PartDto(
    val type: String, // "text" | "tools"
    val text: String? = null, // set on "text" parts
    val count: Int = 0, // number of tool entries consumed on "tools" parts
)

@Serializable
data class ToolMetaDto(
    val server: String,
    val name: String,
    val ok: Boolean,
    // Full call detail so the tool card is openable/readable (mirrors the web).
    val args: String? = null,
    val result: String? = null,
)

// GET/POST /api/mcp/prefs (per-user tool-use opt-out; null = follow instance).
@Serializable
data class McpPrefsDto(val userEnabled: Boolean? = null, val instanceEnabled: Boolean = true)

// GET /api/audio/config. enabled ⇔ the FAST model is flagged audio-input in
// the synced catalog (server-side capability, M2b); smart is never used for voice.
@Serializable
data class AudioConfigDto(
    val enabled: Boolean = false,
    val model: String? = null,
    val smartModel: String? = null,
    val compatibleModels: List<String> = emptyList(),
    val smartAudioCapable: Boolean = false,
    val maxAudioBytes: Long = 8388608,
)

// POST /api/chat/messages/{id}/transcribe response (caption retry).
@Serializable
data class TranscribeQueuedDto(val queued: Boolean = false)

// SSE events emitted by POST /api/chat (see app/api/chat/route.ts buildStream).
sealed interface ChatEvent {
    data class ThreadId(val id: String) : ChatEvent
    data class Delta(val text: String) : ChatEvent
    data class ToolProgress(
        val server: String,
        val name: String,
        val status: String,
        val args: String? = null,
        val result: String? = null,
    ) : ChatEvent
    data class Done(val aborted: Boolean) : ChatEvent
    data class Failure(val code: String) : ChatEvent
}

// Admin MCP API (GET /api/admin/mcp), mirrors components/settings/mcp-card.tsx.
// `headers` values arrive pre-masked from the server (never the real secrets).
@Serializable
data class McpToolDto(val name: String, val description: String = "")

@Serializable
data class McpHealthDto(val ok: Boolean = false, val toolCount: Int = 0, val error: String? = null, val code: String? = null)

@Serializable
data class McpOauthDto(val configured: Boolean = false, val authorized: Boolean = false)

@Serializable
data class McpServerDto(
    val id: String,
    val builtin: Boolean = false,
    val name: String,
    val url: String? = null,
    val enabled: Boolean = false,
    val headers: Map<String, String>? = null,
    val disabledTools: List<String> = emptyList(),
    /** Username of the owner for user-owned rows (null = global/builtin). */
    val owner: String? = null,
    val health: McpHealthDto = McpHealthDto(),
    val tools: List<McpToolDto> = emptyList(),
)

@Serializable
data class McpAdminDto(
    val mcpEnabled: Boolean = false,
    val userPrivateUrls: Boolean = false,
    val servers: List<McpServerDto> = emptyList(),
)

// GET/POST /api/mcp/servers — user-owned MCP servers (owner-scoped, remote HTTP
// only). `serversEnabled` = the admin guardrail (mcp.userServersEnabled);
// `maxServers` = per-user quota. `headers` values arrive pre-masked (never the
// real secrets).
@Serializable
data class McpUserServerDto(
    val id: String,
    val name: String,
    val url: String? = null,
    val enabled: Boolean = false,
    val headers: Map<String, String>? = null,
    val disabledTools: List<String> = emptyList(),
    val oauth: McpOauthDto = McpOauthDto(),
    val health: McpHealthDto = McpHealthDto(),
    val tools: List<McpToolDto> = emptyList(),
)

@Serializable
data class McpUserServersDto(
    val serversEnabled: Boolean = false,
    val privateUrlsAllowed: Boolean = true,
    val maxServers: Int = 0,
    val servers: List<McpUserServerDto> = emptyList(),
)

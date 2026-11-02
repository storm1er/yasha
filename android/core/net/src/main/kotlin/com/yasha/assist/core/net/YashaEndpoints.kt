package com.yasha.assist.core.net

// Single source of truth for the Yasha backend paths (mirrors app/api/* routes).
// Auth: better-auth session cookie (decision D-2, PLAN.md §8).
data class YashaEndpoints(val baseUrl: String) {
    val base get() = baseUrl.trimEnd('/')
    val signIn get() = "$base/api/auth/sign-in/email"
    val signInUsername get() = "$base/api/auth/sign-in/username"
    val signOut get() = "$base/api/auth/sign-out"
    val session get() = "$base/api/auth/get-session"
    val models get() = "$base/api/models"
    val threads get() = "$base/api/threads"
    val chat get() = "$base/api/chat"
    val mcpPrefs get() = "$base/api/mcp/prefs"
    val mcpServers get() = "$base/api/mcp/servers"
    val adminMcp get() = "$base/api/admin/mcp"
    val audioConfig get() = "$base/api/audio/config"
    val attachmentLimits get() = "$base/api/attachment-limits"
    val appVersion get() = "$base/api/app/version"
    val appUpdate get() = "$base/api/app-update"
    fun messageTranscribe(id: String) = "$base/api/chat/messages/$id/transcribe"

    companion object {
        const val ATTACHMENT_MAX_SIDE = 1568 // mirrors lib/image-attachment.ts
    }
}

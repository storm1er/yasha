package com.yasha.assist.feature.chat

// Maps server error codes (app/api/chat/route.ts + better-auth) to string
// resources. Prefix arms: upstream_status_*, http_*, invalid_attachment_*.
object ErrorStrings {
    fun messageRes(code: String): Int = when {
        code == "unauthorized" -> R.string.error_unauthorized
        code == "busy" -> R.string.error_busy
        code == "no_model_configured" -> R.string.error_no_model
        code == "invalid_model" -> R.string.error_invalid_model
        code == "invalid_message" || code == "invalid_json" -> R.string.error_invalid_message
        code == "not_found" -> R.string.error_not_found
        code == "invalid_attachment_too_many" || code == "attachment_too_many" -> R.string.error_attachment_too_many
        code == "invalid_attachment_too_large" || code == "too_large" -> R.string.error_attachment_too_large
        code == "invalid_attachment_unsupported" || code == "unsupported" -> R.string.error_attachment_unsupported
        code == "invalid_url" -> R.string.error_invalid_url
        code == "no_vision_model" -> R.string.no_vision_model
        code == "no_cookie" || code == "bad_credentials" || code == "INVALID_EMAIL_OR_PASSWORD" || code == "USER_NOT_FOUND" -> R.string.error_bad_credentials
        code == "network" || code == "upstream_models" || code.startsWith("upstream_status") || code.startsWith("http_") -> R.string.error_network
        code == "app_updates_disabled" -> R.string.error_updates_disabled
        code.startsWith("upstream") || code == "empty_response" -> R.string.error_upstream
        else -> R.string.error_generic
    }
}

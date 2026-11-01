package com.yasha.assist.core.net

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

// POST /api/chat attachments: images array + at most ONE audio data URL
// (AUDIO-REFACTO-PLAN §4).
@Serializable
data class ChatAttachments(
    val images: List<String>? = null,
    val audio: String? = null,
)

@Serializable
data class ChatRequestBody(
    val message: String,
    val threadId: String? = null,
    val model: String? = null,
    val attachments: ChatAttachments? = null,
)

// Maps one SSE payload JSON to a ChatEvent (pure — unit-tested). Protocol v2
// (lib/chat/stream.ts): chunk `type` dispatch — custom data parts
// (`data-thread`, `data-tool`, `data-error {code}`), `text-delta` for tokens,
// and the terminal `[DONE]` sentinel (no explicit done frame; a stream that
// ends BEFORE [DONE] never yields Done — the caller treats that as aborted).
object ChatEvents {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(payload: String): ChatEvent? = try {
        if (payload == "[DONE]") {
            ChatEvent.Done(aborted = false)
        } else when (val obj = json.parseToJsonElement(payload)) {
            is JsonObject -> when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                "text-delta" -> obj["delta"]?.jsonPrimitive?.contentOrNull?.let { ChatEvent.Delta(it) }
                "data-thread" -> (obj["data"] as? JsonObject)
                    ?.get("threadId")?.jsonPrimitive?.contentOrNull?.let { ChatEvent.ThreadId(it) }
                "data-error" -> (obj["data"] as? JsonObject)
                    ?.get("code")?.jsonPrimitive?.contentOrNull?.let { ChatEvent.Failure(it) }
                "data-tool" -> (obj["data"] as? JsonObject)?.let { tool ->
                    ChatEvent.ToolProgress(
                        server = tool["server"]?.jsonPrimitive?.content.orEmpty(),
                        name = tool["name"]?.jsonPrimitive?.content.orEmpty(),
                        status = tool["status"]?.jsonPrimitive?.content.orEmpty(),
                        args = tool["args"]?.jsonPrimitive?.contentOrNull,
                        result = tool["result"]?.jsonPrimitive?.contentOrNull,
                        truncated = tool["truncated"]?.jsonPrimitive?.booleanOrNull == true,
                        // Issue #16: validated server-side, but decode defensively —
                        // an unexpected shape degrades to a plain chip.
                        card = (tool["card"] as? JsonObject)?.let { c ->
                            try {
                                json.decodeFromJsonElement(CardDto.serializer(), c)
                            } catch (_: Exception) {
                                null
                            }
                        },
                    )
                }
                else -> null // start / text-start / text-end / finish / sources: no app effect
            }
            else -> null
        }
    } catch (_: Exception) {
        null
    }
}

sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data class Err(val code: String) : ApiResult<Nothing>
}

class YashaClient(private val store: SessionStore) : YashaApi, YashaChatApi {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS) // SSE: no read timeout
        .build()

    private fun endpoints() = YashaEndpoints(store.baseUrl)

    private fun requestBuilder(url: String) = Request.Builder().url(url).apply {
        store.token?.let { header("Cookie", SessionStore.cookieHeader(it)) }
    }

    private suspend fun call(url: String, builder: Request.Builder.() -> Unit = {}): ApiResult<String> =
        withContext(Dispatchers.IO) {
            try {
                http.newCall(requestBuilder(url).apply(builder).build()).execute().use { r ->
                    val body = r.body?.string().orEmpty()
                    if (r.isSuccessful) ApiResult.Ok(body) else ApiResult.Err(errorCodeOf(r.code, body))
                }
            } catch (_: IOException) {
                ApiResult.Err("network")
            }
        }

    // better-auth password sign-in: an email-shaped identifier uses
    // /sign-in/email, anything else uses the username plugin's /sign-in/username
    // (same dispatch as the web login form). The session token comes back as
    // Set-Cookie (no CSRF needed: no browser Origin header — verified against
    // the live server).
    override suspend fun signIn(identifier: String, password: String): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val isEmail = EMAIL_SHAPE.matches(identifier)
        val body = buildJsonObject {
            put(if (isEmail) "email" else "username", identifier)
            put("password", password)
        }.toString()
        try {
            http.newCall(
                requestBuilder(if (isEmail) endpoints().signIn else endpoints().signInUsername)
                    .header("Content-Type", "application/json")
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build(),
            ).execute().use { r ->
                if (!r.isSuccessful) {
                    return@use ApiResult.Err(errorCodeOf(r.code, r.body?.string().orEmpty()))
                }
                val token = SessionStore.parseSessionCookie(r.headers.values("Set-Cookie"))
                    ?: return@use ApiResult.Err("no_cookie")
                store.token = token
                store.email = identifier
                ApiResult.Ok(Unit)
            }
        } catch (_: IOException) {
            ApiResult.Err("network")
        }
    }

    override suspend fun signOut() {
        call(endpoints().signOut) { post(ByteArray(0).toRequestBody(null)) }
        store.clearSession()
    }

    // Issue #14: tri-state on purpose. Only a server-confirmed sign-out (401
    // or a 200 body without a session) is `Invalid`; anything else — airplane
    // mode, DNS, timeout, 5xx — is `Unreachable` and must keep the token.
    override suspend fun probeSession(): SessionProbe = when (val r = call(endpoints().session)) {
        is ApiResult.Ok -> if (r.value.contains("\"session\"")) SessionProbe.Valid else SessionProbe.Invalid
        is ApiResult.Err -> if (r.code == "unauthorized") SessionProbe.Invalid else SessionProbe.Unreachable
    }

    override suspend fun fetchModels(): ApiResult<ModelsDto> = decode(call(endpoints().models)) { json.decodeFromString<ModelsDto>(it) }

    override suspend fun listThreads(): ApiResult<List<ThreadRowDto>> = decode(call(endpoints().threads)) { json.decodeFromString<ThreadsDto>(it).threads }

    override suspend fun openThread(id: String): ApiResult<ThreadDetailDto> =
        decode(call("${endpoints().threads}/$id")) { json.decodeFromString<ThreadDetailDto>(it) }

    override suspend fun deleteThread(id: String): ApiResult<Unit> =
        decode(call("${endpoints().threads}/$id") { delete() }) { }

    // Generic JSON passthrough for the settings screens (paths mirror app/api/*).
    override suspend fun getJson(path: String): ApiResult<String> = call(endpoints().base + path)

    override suspend fun postJson(path: String, body: String): ApiResult<String> =
        call(endpoints().base + path) {
            header("Content-Type", "application/json")
            post(body.toRequestBody("application/json".toMediaType()))
        }

    override suspend fun patchJson(path: String, body: String): ApiResult<String> =
        call(endpoints().base + path) {
            header("Content-Type", "application/json")
            patch(body.toRequestBody("application/json".toMediaType()))
        }

    override suspend fun deleteJson(path: String): ApiResult<String> =
        call(endpoints().base + path) { delete() }

    // Audio input (AUDIO-REFACTO-PLAN): feature config + caption retry.
    override suspend fun audioConfig(): ApiResult<AudioConfigDto> =
        decode(call(endpoints().audioConfig)) { json.decodeFromString<AudioConfigDto>(it) }

    override suspend fun retryTranscribe(messageId: String): ApiResult<Boolean> =
        decode(call(endpoints().messageTranscribe(messageId)) {
            post(ByteArray(0).toRequestBody("application/json".toMediaType()))
        }) { json.decodeFromString<TranscribeQueuedDto>(it).queued }

    // POST /api/chat, SSE-framed events mapped to ChatEvent. Cancelling the
    // collected flow cancels the HTTP call (server persists the partial turn).
    override fun chatStream(body: ChatRequestBody): Flow<ChatEvent> = callbackFlow {
        val request = requestBuilder(endpoints().chat)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .post(json.encodeToString(ChatRequestBody.serializer(), body).toRequestBody("application/json".toMediaType()))
            .build()
        val call = http.newCall(request)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                trySend(if (call.isCanceled()) ChatEvent.Done(aborted = true) else ChatEvent.Failure("network"))
                close()
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { r ->
                    if (!r.isSuccessful) {
                        trySend(ChatEvent.Failure(errorCodeOf(r.code, r.body?.string().orEmpty())))
                        close()
                        return
                    }
                    val parser = SseParser()
                    try {
                        r.body?.source()?.use { src ->
                            while (true) {
                                val line = src.readUtf8Line() ?: break
                                // Re-feed the line stream into the frame parser;
                                // a blank line completes one SSE frame.
                                parser.append(if (line.isEmpty()) "\n" else "$line\n")
                                    .forEach { payload -> ChatEvents.parse(payload)?.let { trySend(it) } }
                            }
                        }
                    } catch (_: IOException) {
                        if (!call.isCanceled()) trySend(ChatEvent.Failure("network"))
                    }
                    close()
                }
            }
        })
        awaitClose { call.cancel() }
    }.flowOn(Dispatchers.IO)

    private fun <T> decode(r: ApiResult<String>, map: (String) -> T): ApiResult<T> =
        if (r is ApiResult.Err) r else ApiResult.Ok(map((r as ApiResult.Ok).value))

    companion object {
        // Same loose shape the web login uses to choose the auth endpoint.
        private val EMAIL_SHAPE = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
        fun errorCodeOf(status: Int, body: String): String {
            if (status == 401) return "unauthorized"
            val code = Regex("\"error\"\\s*:\\s*\"([a-z0-9_]+)\"").find(body)?.groupValues?.get(1)
            return code ?: "http_$status"
        }
    }
}

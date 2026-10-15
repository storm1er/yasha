package com.yasha.assist.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.AppLocale
import com.yasha.assist.core.net.McpAdminDto
import com.yasha.assist.core.net.McpPrefsDto
import com.yasha.assist.core.net.McpServerDto
import com.yasha.assist.core.net.McpUserServerDto
import com.yasha.assist.core.net.McpUserServersDto
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// Browser-based OAuth consent polling (matches the web card's cadence).
private const val POLL_DELAY_MS = 2_500L
private const val POLL_ATTEMPTS = 24

// headers map → JSON object for the merge-patch payload: a string upserts the
// header, null deletes it (masked values never round-trip).
private fun headersJson(headers: Map<String, String?>): JsonObject = buildJsonObject {
    headers.forEach { (k, v) -> put(k, if (v == null) JsonNull else JsonPrimitive(v)) }
}

// Page size of the paginated GET /api/memory list (matches the web panel).
private const val MEMORY_PAGE_SIZE = 50

data class ApiKeyRow(val id: String, val name: String, val masked: String, val createdAt: String, val revoked: Boolean)

data class UserRow(val id: String, val username: String, val email: String, val role: String)

data class MemoryRow(
    val id: String,
    val kind: String,
    val text: String,
    val source: String,
    val pinned: Boolean,
    val confidence: String? = null,
)

data class TaskConfig(
    val schedule: String = "after_persist",
    val idleMinutes: String = "30",
    val cronExpr: String = "0 4 * * *",
    val model: String = "",
    val timeoutSec: String = "60",
    val maxAttempts: String = "3",
    val enabled: Boolean = true,
)

data class ModelRow(val id: String, val recipe: String, val size: String, val downloaded: Boolean)

data class JobRow(
    val id: String,
    val type: String,
    val status: String,
    val attempts: Int,
    val maxAttempts: Int,
    val scope: String,
    val lastError: String,
)

data class SettingsUiState(
    val isAdmin: Boolean = false,
    val busy: Boolean = false,
    // one-shot snackbar: incrementing tick + already-localized label
    val noticeTick: Int = 0,
    val notice: String = "",
    val apiKeys: List<ApiKeyRow> = emptyList(),
    val users: List<UserRow> = emptyList(),
    val self: UserRow? = null,
    val keysActive: Int = 0,
    val keysMax: Int = 20,
    val newKey: String? = null,
    val apiTimeoutSec: String = "",
    val apiMaxTokensDefault: String = "",
    val apiMaxTokensCap: String = "",
    // auth.allowRegistration kill-switch (admin; mirrors the web security panel).
    val registrationAllowed: Boolean = true,
    val chatCapableModels: List<String> = emptyList(),
    val titleTask: TaskConfig = TaskConfig(),
    val audioTask: TaskConfig = TaskConfig(),
    val memories: List<MemoryRow> = emptyList(),
    val memoriesHasMore: Boolean = false,
    val memoriesTotal: Int = 0,
    val memoryUserEnabled: Boolean = true,
    val memoryInstanceEnabled: Boolean? = null,
    val mcpUserEnabled: Boolean = true,
    val mcpInstanceEnabled: Boolean? = null,
    val adminMcpEnabled: Boolean = true,
    val adminMcpUserPrivateUrls: Boolean = false,
    val mcpServers: List<McpServerDto> = emptyList(),
    val mcpLoaded: Boolean = false,
    val userMcpServers: List<McpUserServerDto> = emptyList(),
    val userMcpPrivateUrlsAllowed: Boolean = true,
    val userMcpEnabled: Boolean = false,
    val userMcpMax: Int = 0,
    val userMcpLoaded: Boolean = false,
    // Authorization URL the last `connect` produced; the screen opens it in the
    // browser once and calls userMcpAuthUrlHandled().
    val userMcpAuthUrl: String? = null,
    val memoryProfile: String? = null,
    val memoryProfileVersion: Int? = null,
    val memoryEnabledAdmin: Boolean = true,
    val tuneBudget: String = "",
    val tuneTopK: String = "",
    val tuneMsgTrunc: String = "",
    val tuneTranscriptCap: String = "",
    val factTask: TaskConfig = TaskConfig(),
    val summaryTask: TaskConfig = TaskConfig(),
    val dreamTask: TaskConfig = TaskConfig(),
    val serverOnline: Boolean? = null,
    // Account output/UI locale (user.locale from /api/me; null = default).
    val accountLocale: String? = null,
    val serverLoaded: List<String> = emptyList(),
    val catalog: List<ModelRow> = emptyList(),
    val catalogError: Boolean = false,
    val mutationsEnabled: Boolean = false,
    val fastModel: String = "",
    val smartModel: String = "",
    val chatWindowMessages: String = "",
    val chatTimeoutSec: String = "",
    val chatMaxImages: String = "",
    val chatMaxWindowImages: String = "",
    val chatMaxUploadMb: String = "",
    val registryQuery: String = "",
    val registryResults: List<String> = emptyList(),
    val registryDone: Boolean = false,
    val variantsFor: String = "",
    val variants: List<String> = emptyList(),
    val jobsFilter: String = "active",
    val jobs: List<JobRow> = emptyList(),
    val runConcurrency: String = "",
    val runClaimSec: String = "",
    val runStaleSec: String = "",
    val runRetentionDays: String = "",
)

// `scope` is injectable for unit tests (defaults to viewModelScope in prod).
class SettingsViewModel(
    private val client: YashaApi,
    scopeOverride: CoroutineScope? = null,
    private val pollDelayMs: Long = POLL_DELAY_MS,
    // Observes account-locale changes (from /api/me or the picker) so the app
    // can apply the override + recreate; wired in MainActivity, unit-testable.
    private val localeSink: (String?) -> Unit = {},
) : ViewModel() {
    private val scope: CoroutineScope = scopeOverride ?: viewModelScope
    private val json = Json { ignoreUnknownKeys = true }
    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    private fun jsonObj(s: String): JsonObject? = try { json.parseToJsonElement(s) as? JsonObject } catch (_: Exception) { null }
    private fun JsonElement.asObj(): JsonObject? = this as? JsonObject
    private fun JsonElement.asArr(): JsonArray? = this as? JsonArray

    private fun notice(text: String) = _state.update { it.copy(notice = text, noticeTick = it.noticeTick + 1) }

    private var values: Map<String, JsonElement> = emptyMap()

    fun open() {
        scope.launch {
            val s = client.getJson("/api/admin/settings")
            if (s is ApiResult.Ok) {
                values = jsonObj(s.value)?.get("values")?.asObj() ?: emptyMap()
                _state.update { it.copy(isAdmin = true) }
            } else {
                _state.update { it.copy(isAdmin = false) }
            }
            loadGeneral()
            loadSelf()
            if (isAdminNow()) {
                loadTasksFromValues()
                loadUsers()
            }
            loadMemories()
            loadMcpPrefs()
            loadUserMcp()
            if (isAdminNow()) loadAdminMcp()
        }
    }

    private fun isAdminNow() = _state.value.isAdmin

    fun onTab(tab: String) {
        viewModelScope.launch {
            when (tab) {
                "general" -> { loadMcpPrefs(); loadUserMcp() }
                "security" -> { refreshValues(); loadGeneral(); loadSelf(); if (isAdminNow()) loadUsers() }
                "memory" -> { refreshValues(); loadMemories(); if (isAdminNow()) loadTasksFromValues() }
                "lemonade" -> { loadLemonade(); if (isAdminNow()) loadAdminMcp() }
                "jobs" -> { refreshValues(); loadRuntime(); loadJobs() }
            }
        }
    }

    private suspend fun refreshValues() {
        val s = client.getJson("/api/admin/settings")
        if (s is ApiResult.Ok) values = jsonObj(s.value)?.get("values")?.asObj() ?: emptyMap()
    }

    // ── General: API keys + limits ───────────────────────────────────────────
    fun loadGeneral() {
        scope.launch {
            val r = client.getJson("/api/api-keys")
            if (r is ApiResult.Ok) {
                val obj = jsonObj(r.value)
                val keys = obj?.get("keys")?.asArr()?.mapNotNull {
                    val o = it.asObj() ?: return@mapNotNull null
                    ApiKeyRow(
                        id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        name = o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        masked = o["masked"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        createdAt = o["createdAt"]?.jsonPrimitive?.contentOrNull.orEmpty().take(10),
                        revoked = o["revokedAt"]?.jsonPrimitive?.contentOrNull != null,
                    )
                }.orEmpty()
                _state.update {
                    it.copy(apiKeys = keys, keysActive = obj?.get("activeCount")?.jsonPrimitive?.intOrNull ?: 0, keysMax = obj?.get("maxActive")?.jsonPrimitive?.intOrNull ?: 20)
                }
            }
            val lim = values["api.firstTokenTimeoutMs"]?.jsonPrimitive?.longOrNull
            _state.update {
                it.copy(
                    apiTimeoutSec = lim?.let { v -> (v / 1000.0).toString().removeSuffix(".0") } ?: it.apiTimeoutSec,
                    apiMaxTokensDefault = values["api.maxTokensDefault"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    apiMaxTokensCap = values["api.maxTokensCap"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    registrationAllowed = values["auth.allowRegistration"]?.jsonPrimitive?.booleanOrNull ?: true,
                )
            }
        }
    }

    fun createApiKey(name: String, onCreated: (String) -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            val r = client.postJson("/api/api-keys", buildJsonObject { put("name", name.trim()) }.toString())
            _state.update { it.copy(busy = false) }
            if (r is ApiResult.Ok) {
                val key = jsonObj(r.value)?.get("key")?.jsonPrimitive?.contentOrNull
                if (key != null) { onCreated(key); loadGeneral() } else notice("err")
            } else notice(if (r is ApiResult.Err && r.code == "http_409") "limit" else "err")
        }
    }

    fun revokeApiKey(id: String) {
        viewModelScope.launch {
            client.deleteJson("/api/api-keys/$id")
            loadGeneral()
        }
    }

    fun setApiField(key: String, value: String) = _state.update {
        when (key) {
            "timeout" -> it.copy(apiTimeoutSec = value)
            "def" -> it.copy(apiMaxTokensDefault = value)
            else -> it.copy(apiMaxTokensCap = value)
        }
    }

    fun saveApiLimits() = postSettings(
        buildJsonObject {
            val t = _state.value.apiTimeoutSec.replace(',', '.').toDoubleOrNull()
            if (t != null && t > 0) put("api.firstTokenTimeoutMs", (t * 1000).toLong())
            _state.value.apiMaxTokensDefault.toIntOrNull()?.let { if (it > 0) put("api.maxTokensDefault", it) }
            _state.value.apiMaxTokensCap.toIntOrNull()?.let { if (it > 0) put("api.maxTokensCap", it) }
        },
    )

    fun setRegistrationEnabled(next: Boolean) {
        _state.update { it.copy(registrationAllowed = next) }
        postSettings(buildJsonObject { put("auth.allowRegistration", next) })
    }

    // ── Event-config task cards ──────────────────────────────────────────────
    private fun readTask(key: String): TaskConfig {
        val o = values[key]?.asObj() ?: return TaskConfig()
        fun s(k: String, d: String) = o[k]?.jsonPrimitive?.contentOrNull ?: d
        return TaskConfig(
            schedule = o["schedule"]?.jsonPrimitive?.contentOrNull ?: "after_persist",
            idleMinutes = s("idleMinutes", "30"),
            cronExpr = s("cronExpr", "0 4 * * *"),
            model = s("model", ""),
            timeoutSec = o["timeoutMs"]?.jsonPrimitive?.longOrNull?.let { (it / 1000.0).toString().removeSuffix(".0") } ?: "60",
            maxAttempts = o["maxAttempts"]?.jsonPrimitive?.intOrNull?.toString() ?: "3",
            enabled = o["enabled"]?.jsonPrimitive?.booleanOrNull ?: true,
        )
    }

    private suspend fun loadChatModelOptions() {
        val m = client.getJson("/api/admin/models")
        val ids = if (m is ApiResult.Ok) jsonObj(m.value)?.get("models")?.asArr()?.mapNotNull {
            val o = it.asObj() ?: return@mapNotNull null
            val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val dl = o["downloaded"]?.jsonPrimitive?.booleanOrNull == true
            val chat = o["labels"]?.asArr()?.any { l -> l.jsonPrimitive.contentOrNull == "chat" } == true
            if (chat && (dl || id.startsWith("openrouter"))) id else null
        }?.sorted().orEmpty() else _state.value.chatCapableModels
        _state.update { it.copy(chatCapableModels = ids) }
    }

    private fun loadTasksFromValues() {
        viewModelScope.launch {
            loadChatModelOptions()
            _state.update {
                it.copy(
                    titleTask = readTask("chat.title_generation"),
                    audioTask = readTask("chat.audio_transcription"),
                    factTask = readTask("memory.events.fact_extraction"),
                    summaryTask = readTask("memory.events.thread_summary"),
                    dreamTask = readTask("memory.events.dreaming"),
                )
            }
        }
    }

    fun setTaskField(task: String, block: (TaskConfig) -> TaskConfig) = _state.update {
        when (task) {
            "title" -> it.copy(titleTask = block(it.titleTask))
            "audio" -> it.copy(audioTask = block(it.audioTask))
            "fact" -> it.copy(factTask = block(it.factTask))
            "summary" -> it.copy(summaryTask = block(it.summaryTask))
            else -> it.copy(dreamTask = block(it.dreamTask))
        }
    }

    fun saveTask(settingKey: String, cfg: TaskConfig) = postSettings(
        buildJsonObject {
            put(
                settingKey,
                buildJsonObject {
                    put("schedule", cfg.schedule)
                    cfg.idleMinutes.toIntOrNull()?.let { put("idleMinutes", it) }
                    if (cfg.cronExpr.isNotBlank()) put("cronExpr", cfg.cronExpr.trim())
                    if (cfg.model.isNotBlank()) put("model", cfg.model.trim())
                    cfg.timeoutSec.replace(',', '.').toDoubleOrNull()?.let { put("timeoutMs", (it * 1000).toLong()) }
                    cfg.maxAttempts.toIntOrNull()?.let { put("maxAttempts", it) }
                    put("enabled", cfg.enabled)
                },
            )
        },
    )

    private fun postSettings(payload: JsonObject) {
        if (payload.isEmpty()) return
        scope.launch {
            _state.update { it.copy(busy = true) }
            val r = client.postJson("/api/admin/settings", payload.toString())
            _state.update { it.copy(busy = false) }
            if (r is ApiResult.Ok) {
                values = values + payload
                notice("saved")
            } else notice("err")
        }
    }

    // ── Users (admin list + own row) ──────────────────────────────────────────
    private suspend fun loadSelf() {
        val r = client.getJson("/api/me")
        if (r !is ApiResult.Ok) return
        val o = jsonObj(r.value)?.get("user")?.asObj() ?: return
        val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return
        val accountLocale = AppLocale.localeFromMeJson(r.value)
        localeSink(accountLocale)
        _state.update {
            it.copy(
                accountLocale = accountLocale,
                self = UserRow(
                    id = id,
                    username = o["username"]?.jsonPrimitive?.contentOrNull
                        ?: o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    email = o["email"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    role = o["role"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                ),
            )
        }
    }

    private suspend fun loadUsers() {
        val r = client.getJson("/api/admin/users")
        if (r !is ApiResult.Ok) return
        val rows = jsonObj(r.value)?.get("users")?.asArr()?.mapNotNull {
            val o = it.asObj() ?: return@mapNotNull null
            val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            UserRow(
                id = id,
                username = o["username"]?.jsonPrimitive?.contentOrNull
                    ?: o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                email = o["email"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                role = o["role"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
        }.orEmpty()
        _state.update { it.copy(users = rows) }
    }

    fun saveUser(userId: String, username: String?, email: String?, password: String?) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            val body = buildJsonObject {
                put("userId", userId)
                username?.let { put("username", it) }
                email?.let { put("email", it) }
                password?.let { put("password", it) }
            }
            val r = client.patchJson("/api/admin/users", body.toString())
            _state.update { it.copy(busy = false) }
            when (r) {
                is ApiResult.Ok -> { notice("saved"); loadUsers(); loadSelf() }
                is ApiResult.Err ->
                    notice(if (r.code == "username_taken" || r.code == "email_taken") r.code else "err")
            }
        }
    }

    // ── Memory ────────────────────────────────────────────────────────────────
    // offset/append: offset 0 replaces the list; further offsets append a page.
    // (Uses the injectable `scope` = viewModelScope in prod, for unit tests.)
    fun loadMemories(offset: Int = 0, append: Boolean = false) {
        scope.launch {
            val r = client.getJson("/api/memory?limit=$MEMORY_PAGE_SIZE&offset=$offset")
            if (r !is ApiResult.Ok) return@launch
            val obj = jsonObj(r.value)
            val rows = obj?.get("memories")?.asArr()?.mapNotNull {
                val o = it.asObj() ?: return@mapNotNull null
                MemoryRow(
                    id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    kind = o["kind"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    text = o["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    source = o["source"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    pinned = o["pinned"]?.jsonPrimitive?.booleanOrNull == true,
                    confidence = o["confidence"]?.jsonPrimitive?.contentOrNull,
                )
            }.orEmpty()
            val card = obj?.get("card")?.asObj()
            _state.update {
                it.copy(
                    memories = if (append) it.memories + rows else rows,
                    memoriesHasMore = obj?.get("hasMore")?.jsonPrimitive?.booleanOrNull ?: false,
                    memoriesTotal = obj?.get("total")?.jsonPrimitive?.intOrNull ?: rows.size,
                    memoryUserEnabled = obj?.get("userEnabled")?.jsonPrimitive?.booleanOrNull ?: true,
                    memoryInstanceEnabled = obj?.get("instanceEnabled")?.jsonPrimitive?.booleanOrNull,
                    memoryProfile = card?.get("text")?.jsonPrimitive?.contentOrNull,
                    memoryProfileVersion = card?.get("version")?.jsonPrimitive?.intOrNull,
                    memoryEnabledAdmin = values["memory.enabled"]?.jsonPrimitive?.booleanOrNull ?: true,
                    tuneBudget = values["memory.recall.tokenBudget"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    tuneTopK = values["memory.recall.topK"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    tuneMsgTrunc = values["memory.transcript.msgTruncChars"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    tuneTranscriptCap = values["memory.transcript.capChars"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                )
            }
        }
    }

    fun loadMoreMemories() = loadMemories(_state.value.memories.size, append = true)

    fun addMemory(text: String, kind: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            client.postJson("/api/memory", buildJsonObject { put("text", text.trim()); put("kind", kind) }.toString())
            loadMemories()
        }
    }

    fun editMemory(id: String, text: String) {
        viewModelScope.launch {
            client.patchJson("/api/memory/$id", buildJsonObject { put("text", text.trim()) }.toString())
            loadMemories()
        }
    }

    fun pinMemory(id: String, pinned: Boolean) {
        viewModelScope.launch {
            client.patchJson("/api/memory/$id", buildJsonObject { put("pinned", pinned) }.toString())
            loadMemories()
        }
    }

    fun deleteMemory(id: String) {
        viewModelScope.launch {
            client.deleteJson("/api/memory/$id")
            loadMemories()
        }
    }

    fun setMemoryOptOut(enabled: Boolean) {
        viewModelScope.launch {
            client.postJson("/api/memory/prefs", buildJsonObject { if (!enabled) put("userEnabled", false) else put("userEnabled", null) }.toString())
            _state.update { it.copy(memoryUserEnabled = enabled) }
        }
    }

    // ── Tools (MCP) per-user opt-out ────────────────────────────────────────
    fun loadMcpPrefs() {
        scope.launch {
            val r = client.getJson("/api/mcp/prefs")
            if (r !is ApiResult.Ok) return@launch
            val dto = try {
                json.decodeFromString(McpPrefsDto.serializer(), r.value)
            } catch (_: Exception) {
                null
            } ?: return@launch
            _state.update {
                it.copy(
                    mcpUserEnabled = dto.userEnabled ?: true, // null override = follow (default on)
                    mcpInstanceEnabled = dto.instanceEnabled,
                )
            }
        }
    }

    fun setMcpPref(enabled: Boolean) {
        scope.launch {
            // Mirrors the web card: re-checking the box means "follow instance" → null.
            client.postJson(
                "/api/mcp/prefs",
                buildJsonObject { if (enabled) put("userEnabled", null) else put("userEnabled", false) }.toString(),
            )
            _state.update { it.copy(mcpUserEnabled = enabled) }
        }
    }

    // ── User-owned MCP servers (mirrors the web user-mcp-card) ──────────────
    private suspend fun fetchUserMcp(): Boolean {
        val r = client.getJson("/api/mcp/servers")
        if (r !is ApiResult.Ok) return false
        val dto = try {
            json.decodeFromString(McpUserServersDto.serializer(), r.value)
        } catch (_: Exception) {
            null
        } ?: return false
        _state.update {
            it.copy(
                userMcpServers = dto.servers,
                userMcpEnabled = dto.serversEnabled,
                userMcpPrivateUrlsAllowed = dto.privateUrlsAllowed,
                userMcpMax = dto.maxServers,
                userMcpLoaded = true,
            )
        }
        return true
    }

    fun loadUserMcp() {
        scope.launch { fetchUserMcp() }
    }

    // action ∈ add | toggle | delete | check | update; refreshes the list afterwards.
    // update carries the full disabledTools list (mirrors the web card's
    // exclude/include tool buttons). `headers` is a merge-patch: a value
    // upserts that header, null deletes it (masked values never round-trip).
    // Server error codes (quota_exceeded, invalid_url, …) surface as notices.
    // onDone(true/false) reports success so forms can keep their input on failure.
    fun userMcpAction(
        action: String,
        id: String? = null,
        name: String? = null,
        url: String? = null,
        disabledTools: List<String>? = null,
        headers: Map<String, String?>? = null,
        onDone: ((Boolean) -> Unit)? = null,
    ) {
        scope.launch {
            val r = client.postJson(
                "/api/mcp/servers",
                buildJsonObject {
                    put("action", action)
                    id?.let { put("id", it) }
                    name?.let { put("name", it) }
                    url?.let { put("url", it) }
                    disabledTools?.let { list -> put("disabledTools", buildJsonArray { list.forEach { add(it) } }) }
                    headers?.let { map -> put("headers", headersJson(map)) }
                }.toString(),
            )
            val ok = r !is ApiResult.Err
            if (r is ApiResult.Err) notice(r.code) else loadUserMcp()
            onDone?.invoke(ok)
        }
    }

    // OAuth connect for one of the caller's servers. On needsAuth the screen
    // opens userMcpAuthUrl in the browser; we then poll the list until the
    // server reads as authorized (mirrors the web card's popup poll).
    fun userMcpConnect(id: String) {
        scope.launch {
            val r = client.postJson(
                "/api/mcp/servers",
                buildJsonObject {
                    put("action", "connect")
                    put("id", id)
                }.toString(),
            )
            if (r !is ApiResult.Ok) {
                if (r is ApiResult.Err) notice(r.code)
                return@launch
            }
            val body = try {
                json.parseToJsonElement(r.value) as? JsonObject
            } catch (_: Exception) {
                null
            }
            val needsAuth = body?.get("needsAuth")?.jsonPrimitive?.booleanOrNull == true
            val authUrl = body?.get("authorizationUrl")?.jsonPrimitive?.contentOrNull
            if (needsAuth && authUrl != null) {
                _state.update { it.copy(userMcpAuthUrl = authUrl) }
                // Check first, then wait — the consent may already be done.
                for (attempt in 1..POLL_ATTEMPTS) {
                    if (attempt > 1) delay(pollDelayMs)
                    fetchUserMcp()
                    val now = _state.value.userMcpServers.find { it.id == id }
                    if (now?.oauth?.authorized == true) break
                }
            } else {
                fetchUserMcp()
            }
        }
    }

    fun userMcpAuthUrlHandled() {
        _state.update { it.copy(userMcpAuthUrl = null) }
    }

    // ── Admin: Tools (MCP) ───────────────────────────────────────────────────
    fun loadAdminMcp() {
        scope.launch {
            val r = client.getJson("/api/admin/mcp")
            if (r !is ApiResult.Ok) return@launch
            val dto = try {
                json.decodeFromString(McpAdminDto.serializer(), r.value)
            } catch (_: Exception) {
                null
            } ?: return@launch
            _state.update {
                it.copy(
                    adminMcpEnabled = dto.mcpEnabled,
                    adminMcpUserPrivateUrls = dto.userPrivateUrls,
                    mcpServers = dto.servers,
                    mcpLoaded = true,
                )
            }
        }
    }

    fun setMcpGlobalEnabled(next: Boolean) {
        scope.launch {
            client.postJson("/api/admin/settings", buildJsonObject { put("mcp.enabled", next) }.toString())
            _state.update { it.copy(adminMcpEnabled = next) }
        }
    }

    fun setMcpUserPrivateUrls(next: Boolean) {
        scope.launch {
            client.postJson("/api/admin/settings", buildJsonObject { put("mcp.userPrivateUrls", next) }.toString())
            _state.update { it.copy(adminMcpUserPrivateUrls = next) }
        }
    }

    // action ∈ add | toggle | delete | check | update; refreshes the list afterwards.
    // onDone(true/false) reports success so forms can keep their input on failure.
    fun mcpAction(
        action: String,
        id: String? = null,
        name: String? = null,
        url: String? = null,
        disabledTools: List<String>? = null,
        headers: Map<String, String?>? = null,
        onDone: ((Boolean) -> Unit)? = null,
    ) {
        scope.launch {
            val r = client.postJson(
                "/api/admin/mcp",
                buildJsonObject {
                    put("action", action)
                    id?.let { put("id", it) }
                    name?.let { put("name", it) }
                    url?.let { put("url", it) }
                    disabledTools?.let { list -> put("disabledTools", buildJsonArray { list.forEach { add(it) } }) }
                    headers?.let { map -> put("headers", headersJson(map)) }
                }.toString(),
            )
            val ok = r !is ApiResult.Err
            if (r is ApiResult.Err) notice(r.code) else loadAdminMcp()
            onDone?.invoke(ok)
        }
    }

    fun setMemoryEnabledAdmin(next: Boolean) {
        postSettings(buildJsonObject { put("memory.enabled", next) })
        _state.update { it.copy(memoryEnabledAdmin = next) }
    }

    fun setTuneField(which: String, v: String) = _state.update {
        when (which) {
            "budget" -> it.copy(tuneBudget = v)
            "topk" -> it.copy(tuneTopK = v)
            "trunc" -> it.copy(tuneMsgTrunc = v)
            else -> it.copy(tuneTranscriptCap = v)
        }
    }

    fun saveTuning() = postSettings(
        buildJsonObject {
            _state.value.tuneBudget.toIntOrNull()?.let { if (it > 0) put("memory.recall.tokenBudget", it) }
            _state.value.tuneTopK.toIntOrNull()?.let { if (it > 0) put("memory.recall.topK", it) }
            _state.value.tuneMsgTrunc.toIntOrNull()?.let { if (it > 0) put("memory.transcript.msgTruncChars", it) }
            _state.value.tuneTranscriptCap.toIntOrNull()?.let { if (it > 0) put("memory.transcript.capChars", it) }
        },
    )

    // ── Lemonade (admin) ──────────────────────────────────────────────────────
    fun loadLemonade() {
        viewModelScope.launch {
            loadChatModelOptions()
            val srv = client.getJson("/api/admin/server")
            var loaded = _state.value.serverLoaded
            if (srv is ApiResult.Ok) {
                loaded = jsonObj(srv.value)?.get("systemInfo")?.asObj()?.get("models")?.asArr()
                    ?.mapNotNull {
                        val o = it.asObj() ?: return@mapNotNull null
                        if (o["state"]?.jsonPrimitive?.contentOrNull == "loaded") o["id"]?.jsonPrimitive?.contentOrNull else null
                    }.orEmpty()
            }
            _state.update { it.copy(serverOnline = srv is ApiResult.Ok, serverLoaded = loaded) }
            val r = client.getJson("/api/admin/models")
            if (r is ApiResult.Ok) {
                val obj = jsonObj(r.value)
                val rows = obj?.get("models")?.asArr()?.mapNotNull {
                    val o = it.asObj() ?: return@mapNotNull null
                    val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val size = o["size"]?.jsonPrimitive?.floatOrNull?.let { sz -> "%.1f GB".format(sz / 1073741824f) }
                        ?: o["size"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    ModelRow(id, o["recipe"]?.jsonPrimitive?.contentOrNull.orEmpty(), size, o["downloaded"]?.jsonPrimitive?.booleanOrNull == true)
                }.orEmpty()
                _state.update { it.copy(catalog = rows, catalogError = false, mutationsEnabled = obj?.get("mutations_enabled")?.jsonPrimitive?.booleanOrNull == false) }
            } else _state.update { it.copy(catalogError = true) }
            _state.update {
                it.copy(
                    fastModel = values["fast_model"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    smartModel = values["smart_model"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    chatWindowMessages = values["chat.windowMessages"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    chatTimeoutSec = values["chat.firstTokenTimeoutMs"]?.jsonPrimitive?.longOrNull?.let { v -> (v / 1000).toString() } ?: "",
                    chatMaxImages = values["chat.maxImagesPerMessage"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    chatMaxWindowImages = values["chat.maxWindowImages"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                    chatMaxUploadMb = values["chat.maxUploadBytes"]?.jsonPrimitive?.longOrNull?.let { v -> (v / 1048576).toString() } ?: "",
                )
            }
        }
    }

    fun modelAction(action: String, id: String) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            val r = client.postJson("/api/admin/actions", buildJsonObject { put("action", action); put("model", id) }.toString())
            _state.update { it.copy(busy = false) }
            notice(if (r is ApiResult.Ok) "done" else if (r is ApiResult.Err && r.code == "mutations_disabled") "mutations" else "err")
            loadLemonade()
        }
    }

    fun setLemonadeField(key: String, v: String) = _state.update {
        when (key) {
            "fast" -> it.copy(fastModel = v)
            "smart" -> it.copy(smartModel = v)
            "window" -> it.copy(chatWindowMessages = v)
            "chattimeout" -> it.copy(chatTimeoutSec = v)
            "maximg" -> it.copy(chatMaxImages = v)
            "maxwin" -> it.copy(chatMaxWindowImages = v)
            else -> it.copy(chatMaxUploadMb = v)
        }
    }

    fun saveChatModels() = postSettings(
        buildJsonObject {
            _state.value.fastModel.trim().takeIf { it.isNotEmpty() }?.let { put("fast_model", it) }
            _state.value.smartModel.trim().takeIf { it.isNotEmpty() }?.let { put("smart_model", it) }
        },
    )

    fun saveChatLimits() = postSettings(
        buildJsonObject {
            _state.value.chatWindowMessages.toIntOrNull()?.let { if (it > 0) put("chat.windowMessages", it) }
            _state.value.chatTimeoutSec.toLongOrNull()?.let { if (it > 0) put("chat.firstTokenTimeoutMs", it * 1000) }
            _state.value.chatMaxImages.toIntOrNull()?.let { if (it > 0) put("chat.maxImagesPerMessage", it) }
            _state.value.chatMaxWindowImages.toIntOrNull()?.let { if (it > 0) put("chat.maxWindowImages", it) }
            _state.value.chatMaxUploadMb.toLongOrNull()?.let { if (it > 0) put("chat.maxUploadBytes", it * 1048576) }
        },
    )

    fun setRegistryQuery(v: String) = _state.update { it.copy(registryQuery = v) }

    fun registrySearch() {
        val q = _state.value.registryQuery.trim()
        if (q.isBlank()) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, registryDone = false, registryResults = emptyList()) }
            val r = client.getJson("/api/admin/registry?q=${java.net.URLEncoder.encode(q, "UTF-8")}")
            val results = if (r is ApiResult.Ok) {
                val root = jsonObj(r.value)
                val arr = root?.get("results")?.asArr() ?: root?.get("data")?.asArr() ?: root?.get("models")?.asArr()
                arr?.mapNotNull { e ->
                    val o = e.asObj() ?: return@mapNotNull null
                    o["name"]?.jsonPrimitive?.contentOrNull ?: o["id"]?.jsonPrimitive?.contentOrNull ?: o["repo"]?.jsonPrimitive?.contentOrNull
                }.orEmpty()
            } else emptyList()
            _state.update { it.copy(busy = false, registryResults = results, registryDone = true) }
        }
    }

    fun loadVariants(name: String) {
        viewModelScope.launch {
            _state.update { it.copy(variantsFor = name, variants = emptyList()) }
            val r = client.getJson("/api/admin/variants?name=${java.net.URLEncoder.encode(name, "UTF-8")}")
            val list = if (r is ApiResult.Ok) {
                val root = jsonObj(r.value)
                val arr = root?.get("variants")?.asArr() ?: root?.get("results")?.asArr()
                arr?.mapNotNull { e ->
                    val o = e.asObj() ?: return@mapNotNull null
                    val ck = o["checkpoint"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val label = listOfNotNull(o["quant"]?.jsonPrimitive?.contentOrNull, o["size"]?.jsonPrimitive?.contentOrNull)
                    ck + if (label.isNotEmpty()) " — ${label.joinToString(", ")}" else ""
                }.orEmpty()
            } else emptyList()
            _state.update { it.copy(variants = list) }
        }
    }

    fun pullVariant(checkpointLabel: String) {
        val ck = checkpointLabel.substringBefore(" — ")
        val name = _state.value.variantsFor
        val model = name.substringAfterLast('/').ifEmpty { name }
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            val r = client.postJson(
                "/api/admin/actions",
                buildJsonObject {
                    put("action", "pull"); put("model", model); put("recipe", name)
                    put("checkpoint", if (ck.contains(':')) ck else "$name:$ck"); put("source", "huggingface")
                }.toString(),
            )
            _state.update { it.copy(busy = false) }
            notice(if (r is ApiResult.Ok) "done" else if (r is ApiResult.Err && r.code == "mutations_disabled") "mutations" else "err")
        }
    }

    // ── Jobs (admin) ──────────────────────────────────────────────────────────
    fun setJobsFilter(v: String) {
        _state.update { it.copy(jobsFilter = v) }
        loadJobs()
    }

    fun loadJobs() {
        viewModelScope.launch {
            val r = client.getJson("/api/admin/jobs?status=${_state.value.jobsFilter}&limit=100")
            if (r !is ApiResult.Ok) return@launch
            val rows = jsonObj(r.value)?.get("jobs")?.asArr()?.mapNotNull {
                val o = it.asObj() ?: return@mapNotNull null
                val scope = o["scope"]?.asObj()
                val s = listOfNotNull(
                    scope?.get("threadTitle")?.jsonPrimitive?.contentOrNull,
                    scope?.get("userName")?.jsonPrimitive?.contentOrNull,
                ).joinToString(" · ")
                JobRow(
                    id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    type = o["type"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    status = o["status"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    attempts = o["attempts"]?.jsonPrimitive?.intOrNull ?: 0,
                    maxAttempts = o["maxAttempts"]?.jsonPrimitive?.intOrNull ?: 0,
                    scope = s,
                    lastError = o["lastError"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                )
            }.orEmpty()
            _state.update { it.copy(jobs = rows) }
        }
    }

    fun jobAction(action: String, jobId: String) {
        viewModelScope.launch {
            val body = if (jobId.isEmpty()) buildJsonObject { put("action", action) }.toString()
            else buildJsonObject { put("action", action); put("jobId", jobId) }.toString()
            val r = client.postJson("/api/admin/jobs", body)
            notice(if (r is ApiResult.Ok) "done" else "err")
            loadJobs()
        }
    }

    fun setRuntimeField(which: String, v: String) = _state.update {
        when (which) {
            "conc" -> it.copy(runConcurrency = v)
            "claim" -> it.copy(runClaimSec = v)
            "stale" -> it.copy(runStaleSec = v)
            else -> it.copy(runRetentionDays = v)
        }
    }

    fun loadRuntime() {
        fun secs(v: JsonElement?) = v?.jsonPrimitive?.longOrNull?.let { (it / 1000).toString() } ?: ""
        _state.update {
            it.copy(
                runConcurrency = values["memory.queue.concurrency"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
                runClaimSec = secs(values["memory.queue.claimIntervalMs"]),
                runStaleSec = secs(values["memory.queue.staleLeaseMs"]),
                runRetentionDays = values["memory.queue.retentionDays"]?.jsonPrimitive?.intOrNull?.toString() ?: "",
            )
        }
    }

    fun saveRuntime() = postSettings(
        buildJsonObject {
            _state.value.runConcurrency.toIntOrNull()?.let { if (it > 0) put("memory.queue.concurrency", it) }
            _state.value.runClaimSec.toDoubleOrNull()?.let { if (it > 0) put("memory.queue.claimIntervalMs", (it * 1000).toLong()) }
            _state.value.runStaleSec.toDoubleOrNull()?.let { if (it > 0) put("memory.queue.staleLeaseMs", (it * 1000).toLong()) }
            _state.value.runRetentionDays.toIntOrNull()?.let { if (it > 0) put("memory.queue.retentionDays", it) }
        },
    )

    // ── Account language (locale-aware app + generated content) ─────────────
    // Picker entry: applies the override immediately (via localeSink, so the
    // UI follows even before the round-trip) and syncs it to the account.
    fun setAccountLocale(tag: String) {
        if (tag !in AppLocale.SUPPORTED) return
        localeSink(tag)
        _state.update { it.copy(accountLocale = tag) }
        scope.launch {
            client.patchJson("/api/me/locale", buildJsonObject { put("locale", tag) }.toString())
        }
    }

    class Factory(
        private val client: YashaApi,
        private val localeSink: (String?) -> Unit = {},
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
            SettingsViewModel(client, localeSink = localeSink) as T
    }
}

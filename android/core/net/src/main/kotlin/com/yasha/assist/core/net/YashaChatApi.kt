package com.yasha.assist.core.net

import kotlinx.coroutines.flow.Flow

// Outcome of the startup session probe (issue #14). A transport failure must
// never be conflated with a confirmed sign-out: only `Invalid` (the server
// answered 401 / no session) may clear the stored token — `Unreachable`
// leaves it intact (wiping it on airplane mode was unrecoverable for
// credential-seeded APKs, which never re-seed).
sealed interface SessionProbe {
    data object Valid : SessionProbe

    /** Server confirmed: no (valid) session for this token. */
    data object Invalid : SessionProbe

    /** Connection failed / timed out / 5xx — session state is unknown. */
    data object Unreachable : SessionProbe
}

// The YashaClient surface ChatViewModel drives. Same pattern as YashaApi for
// the settings view-model: unit tests substitute a fake to drive the session
// and stream state machines.
interface YashaChatApi {
    suspend fun signIn(identifier: String, password: String): ApiResult<Unit>
    suspend fun signOut()
    suspend fun probeSession(): SessionProbe
    suspend fun fetchModels(): ApiResult<ModelsDto>
    /** Issue #69: fire-and-forget `POST /api/backend/warm`. The server answers
     * as soon as the discarded warm completion is dispatched; every failure
     * is a lost cache miss, never user-visible. `model = null` lets the server
     * resolve `fast_model → smart_model`. */
    suspend fun warmBackend(model: String?): ApiResult<String>
    suspend fun listThreads(): ApiResult<List<ThreadRowDto>>
    suspend fun openThread(id: String): ApiResult<ThreadDetailDto>
    suspend fun deleteThread(id: String): ApiResult<Unit>
    suspend fun audioConfig(): ApiResult<AudioConfigDto>
    suspend fun attachmentLimits(): ApiResult<AttachmentLimitsDto>
    suspend fun fetchAppVersion(): ApiResult<AppVersionDto>
    // Issue #34 Phase B: update-build trigger/poll + one-time APK download.
    suspend fun fetchAppUpdate(): ApiResult<AppUpdateDto>
    suspend fun startAppUpdate(): ApiResult<AppUpdateDto>
    suspend fun downloadApk(path: String, dest: java.io.File, onFraction: (Float) -> Unit): ApiResult<Unit>
    suspend fun retryTranscribe(messageId: String): ApiResult<Boolean>
    fun chatStream(body: ChatRequestBody): Flow<ChatEvent>
}

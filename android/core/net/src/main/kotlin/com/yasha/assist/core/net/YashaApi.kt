package com.yasha.assist.core.net

// Narrow JSON API surface used by the settings view-model. YashaClient is the
// real implementation (session-cookie requests via requestBuilder); unit tests
// substitute a fake to drive the view-model state machine.
interface YashaApi {
    suspend fun getJson(path: String): ApiResult<String>
    suspend fun postJson(path: String, body: String): ApiResult<String>
    suspend fun patchJson(path: String, body: String): ApiResult<String>
    suspend fun deleteJson(path: String): ApiResult<String>
}

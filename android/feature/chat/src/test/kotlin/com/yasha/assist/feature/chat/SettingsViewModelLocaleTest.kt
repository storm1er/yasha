package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Test

private class FakeLocaleApi : YashaApi {
    val patches = mutableListOf<Pair<String, String>>()
    override suspend fun getJson(path: String): ApiResult<String> = ApiResult.Err("not_faked")
    override suspend fun postJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun patchJson(path: String, body: String): ApiResult<String> {
        patches += path to body
        return ApiResult.Ok("{}")
    }

    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

class SettingsViewModelLocaleTest {
    private fun newVm(api: YashaApi, seen: MutableList<String?>) =
        SettingsViewModel(api, CoroutineScope(Dispatchers.Unconfined + SupervisorJob()), localeSink = { seen += it })

    @Test
    fun `setAccountLocale emits the PATCH payload, updates state and notifies the sink`() {
        val api = FakeLocaleApi()
        val seen = mutableListOf<String?>()
        val vm = newVm(api, seen)
        vm.setAccountLocale("fr")
        assertEquals(listOf("/api/me/locale" to """{"locale":"fr"}"""), api.patches)
        assertEquals("fr", vm.state.value.accountLocale)
        assertEquals(listOf<String?>("fr"), seen)
    }

    @Test
    fun `setAccountLocale ignores unsupported tags`() {
        val api = FakeLocaleApi()
        val seen = mutableListOf<String?>()
        val vm = newVm(api, seen)
        vm.setAccountLocale("de")
        assertEquals(emptyList<Pair<String, String>>(), api.patches)
        assertEquals(emptyList<String?>(), seen)
        assertEquals(null, vm.state.value.accountLocale)
    }
}

package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Test

private class FakeApi : YashaApi {
    val posts = mutableListOf<Pair<String, String>>()
    var nextGet: ApiResult<String> = ApiResult.Err("not_faked")
    override suspend fun getJson(path: String): ApiResult<String> = if (path == "/api/mcp/prefs") nextGet else ApiResult.Err("not_faked")
    override suspend fun postJson(path: String, body: String): ApiResult<String> {
        posts += path to body
        return ApiResult.Ok("{}")
    }

    override suspend fun patchJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

private fun newVm(api: FakeApi) = SettingsViewModel(api, CoroutineScope(Dispatchers.Unconfined + SupervisorJob()))

class SettingsViewModelMcpTest {
    @Test
    fun `defaults are follow-instance and unknown instance state`() {
        val state = SettingsUiState()
        assertEquals(true, state.mcpUserEnabled)
        assertEquals(null, state.mcpInstanceEnabled)
    }

    @Test
    fun `loadMcpPrefs parses all three shapes`() {
        var api = FakeApi().apply { nextGet = ApiResult.Ok("""{"userEnabled":null,"instanceEnabled":true}""") }
        var vm = newVm(api)
        vm.loadMcpPrefs()
        assertEquals(true, vm.state.value.mcpUserEnabled)
        assertEquals(true, vm.state.value.mcpInstanceEnabled)

        api = FakeApi().apply { nextGet = ApiResult.Ok("""{"userEnabled":false,"instanceEnabled":true}""") }
        vm = newVm(api)
        vm.loadMcpPrefs()
        assertEquals(false, vm.state.value.mcpUserEnabled)

        api = FakeApi().apply { nextGet = ApiResult.Ok("""{"userEnabled":null,"instanceEnabled":false}""") }
        vm = newVm(api)
        vm.loadMcpPrefs()
        assertEquals(true, vm.state.value.mcpUserEnabled)
        assertEquals(false, vm.state.value.mcpInstanceEnabled)
    }

    @Test
    fun `loadMcpPrefs ignores errors and malformed bodies`() {
        val api = FakeApi()
        val vm = newVm(api)
        vm.loadMcpPrefs() // Err → untouched
        assertEquals(true, vm.state.value.mcpUserEnabled)
        assertEquals(null, vm.state.value.mcpInstanceEnabled)
        api.nextGet = ApiResult.Ok("not json")
        vm.loadMcpPrefs()
        assertEquals(null, vm.state.value.mcpInstanceEnabled)
    }

    @Test
    fun `toggle posts false then null (follow-revert) and updates state`() {
        val api = FakeApi().apply { nextGet = ApiResult.Ok("""{"userEnabled":null,"instanceEnabled":true}""") }
        val vm = newVm(api)

        vm.setMcpPref(false)
        assertEquals("/api/mcp/prefs" to """{"userEnabled":false}""", api.posts.last())
        assertEquals(false, vm.state.value.mcpUserEnabled)

        vm.setMcpPref(true) // re-check = back to following the instance default
        assertEquals("""{"userEnabled":null}""", api.posts.last().second)
        assertEquals(true, vm.state.value.mcpUserEnabled)
    }
}

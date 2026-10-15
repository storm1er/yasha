package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Test

private class FakeRegApi : YashaApi {
    val posts = mutableListOf<Pair<String, String>>()
    var nextGet: Map<String, ApiResult<String>> = emptyMap()
    override suspend fun getJson(path: String): ApiResult<String> = nextGet[path] ?: ApiResult.Err("not_faked")
    override suspend fun postJson(path: String, body: String): ApiResult<String> {
        posts += path to body
        return ApiResult.Ok("{}")
    }

    override suspend fun patchJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

private fun settingsOk(values: String) = ApiResult.Ok("""{"ok":true,"values":$values}""")

private fun newVm(api: FakeRegApi) = SettingsViewModel(api, CoroutineScope(Dispatchers.Unconfined + SupervisorJob()))

class SettingsViewModelRegistrationTest {
    @Test
    fun `open reads auth_allowRegistration from admin settings values`() {
        val api = FakeRegApi().apply {
            nextGet = mapOf("/api/admin/settings" to settingsOk("""{"auth.allowRegistration":false}"""))
        }
        val vm = newVm(api)
        vm.open()
        assertEquals(true, vm.state.value.isAdmin)
        assertEquals(false, vm.state.value.registrationAllowed)
    }

    @Test
    fun `registration defaults to allowed when the key is unset`() {
        val api = FakeRegApi().apply { nextGet = mapOf("/api/admin/settings" to settingsOk("{}")) }
        val vm = newVm(api)
        vm.open()
        assertEquals(true, vm.state.value.registrationAllowed)
    }

    @Test
    fun `toggle posts auth_allowRegistration and updates state`() {
        val api = FakeRegApi().apply {
            nextGet = mapOf("/api/admin/settings" to settingsOk("""{"auth.allowRegistration":true}"""))
        }
        val vm = newVm(api)
        vm.open()
        vm.setRegistrationEnabled(false)
        assertEquals("/api/admin/settings" to """{"auth.allowRegistration":false}""", api.posts.last())
        assertEquals(false, vm.state.value.registrationAllowed)
    }
}

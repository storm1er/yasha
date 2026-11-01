package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Issue #15 parity features on the settings VM: own-sessions management
// (GET/POST /api/me/sessions), per-device theme, and the admin fields the
// Android cards lacked (mcp.userServersEnabled, mcp.toolResultMaxChars,
// memory.dream.* tuning).

private open class RecordedApi : YashaApi {
    val posts = mutableListOf<Pair<String, String>>()
    var getCanned: (String) -> ApiResult<String> = { ApiResult.Ok("{}") }
    override suspend fun getJson(path: String): ApiResult<String> = getCanned(path)
    override suspend fun postJson(path: String, body: String): ApiResult<String> {
        posts += path to body
        return ApiResult.Ok("{}")
    }
    override suspend fun patchJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

class SettingsViewModelSessionsTest {
    private val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())

    @Test
    fun `loadSessions parses rows and marks the current one`() {
        val api = RecordedApi()
        api.getCanned = { path ->
            if (path == "/api/me/sessions") {
                ApiResult.Ok(
                    """{"sessions":[
                        {"id":"s1","current":true,"userAgent":"Mozilla/5.0 (Linux)","ipAddress":"10.0.0.1","lastUsedAt":"2026-10-30T10:00:00.000Z"},
                        {"id":"s2","current":false,"userAgent":"","ipAddress":"10.0.0.2","lastUsedAt":"2026-10-29T09:00:00.000Z"}
                    ]}""",
                )
            } else ApiResult.Err("not_faked")
        }
        val vm = SettingsViewModel(api, scope)
        vm.loadSessions()
        val rows = vm.state.value.sessions
        assertEquals(listOf("s1", "s2"), rows.map { it.id })
        assertEquals(true, rows[0].current)
        assertEquals(false, rows[1].current)
        assertEquals("Mozilla/5.0 (Linux)", rows[0].userAgent)
        assertEquals("10.0.0.2", rows[1].ipAddress)
    }

    @Test
    fun `revokeSession posts the revoke action then reloads`() {
        var reloads = 0
        val api = object : RecordedApi() {
            override suspend fun getJson(path: String): ApiResult<String> {
                if (path == "/api/me/sessions") reloads++
                return ApiResult.Ok("""{"sessions":[]}""")
            }
        }
        val vm = SettingsViewModel(api, scope)
        vm.revokeSession("s2")
        assertEquals("/api/me/sessions" to """{"action":"revoke","sessionId":"s2"}""", api.posts.single())
        assertEquals(1, reloads) // revoke → loadSessions() refresh
    }

    @Test
    fun `revokeOtherSessions posts revokeOthers`() {
        val api = RecordedApi()
        val vm = SettingsViewModel(api, scope)
        vm.revokeOtherSessions()
        assertEquals("/api/me/sessions" to """{"action":"revokeOthers"}""", api.posts.single())
    }
}

class SettingsViewModelThemeTest {
    private val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())

    @Test
    fun `setThemeMode persists through the sink and updates state`() {
        val seen = mutableListOf<String>()
        val vm = SettingsViewModel(RecordedApi(), scope, themeSink = { seen += it })
        vm.setThemeMode(ThemePrefs.DARK)
        assertEquals(listOf(ThemePrefs.DARK), seen)
        assertEquals(ThemePrefs.DARK, vm.state.value.themeMode)
    }

    @Test
    fun `setThemeMode ignores unsupported values`() {
        val seen = mutableListOf<String>()
        val vm = SettingsViewModel(RecordedApi(), scope, themeSink = { seen += it })
        vm.setThemeMode("hot-pink")
        assertTrue(seen.isEmpty())
        assertEquals(ThemePrefs.SYSTEM, vm.state.value.themeMode)
    }

    @Test
    fun `open seeds the picker from the theme source`() {
        val vm = SettingsViewModel(RecordedApi(), scope, themeSource = { ThemePrefs.LIGHT })
        vm.open()
        assertEquals(ThemePrefs.LIGHT, vm.state.value.themeMode)
    }
}

class SettingsViewModelAdminParityTest {
    private val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())

    @Test
    fun `setMcpUserServersEnabled posts the admin setting`() {
        val api = RecordedApi()
        val vm = SettingsViewModel(api, scope)
        vm.setMcpUserServersEnabled(true)
        assertEquals("/api/admin/settings" to """{"mcp.userServersEnabled":true}""", api.posts.single())
        assertTrue(vm.state.value.adminMcpUserServersEnabled)
    }

    @Test
    fun `saveChatLimits includes the tool-result cap within the web bounds`() {
        val api = RecordedApi()
        val vm = SettingsViewModel(api, scope)
        vm.setLemonadeField("toolres", "12000")
        vm.saveChatLimits()
        assertTrue(api.posts.single().second.contains(""""mcp.toolResultMaxChars":12000"""))
        // Out-of-bound values are dropped (server-side cap is 500..100000):
        // an all-empty payload must not hit the endpoint at all.
        vm.setLemonadeField("toolres", "50")
        vm.saveChatLimits()
        assertEquals(1, api.posts.size)
    }

    @Test
    fun `saveTuning writes the dream settings, deadline converted to ms`() {
        val api = RecordedApi()
        val vm = SettingsViewModel(api, scope)
        vm.setTuneField("dreamdeadline", "300")
        vm.setTuneField("dreamchunk", "40")
        vm.setTuneField("dreaminsights", "5")
        vm.setTuneField("dreamrebuild", "10")
        vm.saveTuning()
        val body = api.posts.single().second
        assertTrue(body.contains(""""memory.dream.softDeadlineMs":300000"""))
        assertTrue(body.contains(""""memory.dream.chunkSize":40"""))
        assertTrue(body.contains(""""memory.dream.insightsPerNight":5"""))
        assertTrue(body.contains(""""memory.dream.cardRebuildEvery":10"""))
    }
}

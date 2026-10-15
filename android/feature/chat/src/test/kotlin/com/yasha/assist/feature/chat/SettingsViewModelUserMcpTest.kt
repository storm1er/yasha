package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeUserMcpApi : YashaApi {
    val posts = mutableListOf<Pair<String, String>>()
    val gets = mutableListOf<String>()
    val postResponses = mutableMapOf<String, ApiResult<String>>()
    var nextGet: Map<String, ApiResult<String>> = emptyMap()
    var nextGetProvider: ((String) -> ApiResult<String>)? = null
    var failNextPost: String? = null
    override suspend fun getJson(path: String): ApiResult<String> {
        gets += path
        nextGetProvider?.let { return it(path) }
        return nextGet[path] ?: ApiResult.Err("not_faked")
    }

    override suspend fun postJson(path: String, body: String): ApiResult<String> {
        posts += path to body
        return if (failNextPost == null) postResponses[path] ?: ApiResult.Ok("{}") else {
            val code = failNextPost!!
            failNextPost = null
            ApiResult.Err(code)
        }
    }

    override suspend fun patchJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

private const val USER_LIST =
    """{"ok":true,"serversEnabled":true,"maxServers":5,"servers":[
      {"id":"deepwiki-1","name":"DeepWiki","url":"https://mcp.deepwiki.com/mcp","enabled":true,
       "headers":{"X-Key":"••••"},"disabledTools":["drop"],
       "health":{"ok":true,"toolCount":3,"error":null},
       "tools":[{"name":"ask","description":"ask"},{"name":"read"}]},
      {"id":"off-1","name":"Off","url":"https://off.test/mcp","enabled":false,
       "health":{"ok":false,"toolCount":0,"error":"disabled"}}]}"""

private const val GUARDRAIL_OFF =
    """{"ok":true,"serversEnabled":false,"maxServers":5,"servers":[]}"""

private fun newVm(api: FakeUserMcpApi) =
    SettingsViewModel(api, CoroutineScope(Dispatchers.Unconfined + SupervisorJob()))

class SettingsViewModelUserMcpTest {
    @Test
    fun `loadUserMcp parses guardrail, quota and rows`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        vm.loadUserMcp()
        val st = vm.state.value
        assertTrue(st.userMcpLoaded)
        assertTrue(st.userMcpEnabled)
        assertEquals(5, st.userMcpMax)
        assertEquals(2, st.userMcpServers.size)
        val first = st.userMcpServers[0]
        assertEquals(3, first.health.toolCount)
        assertEquals(listOf("drop"), first.disabledTools)
        assertEquals(listOf("X-Key"), first.headers?.keys?.toList())
        assertEquals("disabled", st.userMcpServers[1].health.error)
    }

    @Test
    fun `guardrail off flips userMcpEnabled false`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(GUARDRAIL_OFF)) }
        val vm = newVm(api)
        vm.loadUserMcp()
        assertFalse(vm.state.value.userMcpEnabled)
        assertTrue(vm.state.value.userMcpLoaded)
    }

    @Test
    fun `loadUserMcp ignores garbage and errors`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok("not json")) }
        val vm = newVm(api)
        vm.loadUserMcp()
        assertFalse(vm.state.value.userMcpLoaded)
        val api2 = FakeUserMcpApi() // getJson → Err("not_faked")
        val vm2 = newVm(api2)
        vm2.loadUserMcp()
        assertFalse(vm2.state.value.userMcpLoaded)
    }

    @Test
    fun `userMcpAction add posts payload then reloads`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        vm.userMcpAction("add", name = "DeepWiki", url = "https://mcp.deepwiki.com/mcp")
        val (path, body) = api.posts.single()
        assertEquals("/api/mcp/servers", path)
        assertTrue(body.contains("\"action\":\"add\""))
        assertTrue(body.contains("\"name\":\"DeepWiki\""))
        assertTrue(body.contains("\"url\":\"https:\\/\\/mcp.deepwiki.com\\/mcp\"") || body.contains("mcp.deepwiki.com"))
        assertTrue(api.gets.contains("/api/mcp/servers")) // reload after success
        assertEquals(2, vm.state.value.userMcpServers.size)
    }

    @Test
    fun `userMcpAction toggle sends id only`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        vm.userMcpAction("toggle", id = "deepwiki-1")
        val body = api.posts.single().second
        assertTrue(body.contains("\"id\":\"deepwiki-1\""))
        assertFalse(body.contains("name"))
    }

    @Test
    fun `userMcpAction update sends disabledTools array and reloads`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        vm.userMcpAction("update", id = "deepwiki-1", disabledTools = listOf("ask", "drop"))
        val (path, body) = api.posts.single()
        assertEquals("/api/mcp/servers", path)
        assertTrue(body.contains("\"action\":\"update\""))
        assertTrue(body.contains("\"id\":\"deepwiki-1\""))
        assertTrue(body.contains("\"disabledTools\":[\"ask\",\"drop\"]"))
        assertTrue(api.gets.contains("/api/mcp/servers")) // reload after success
    }

    @Test
    fun `userMcpAction headers merge-patch serializes upserts and null deletions`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        vm.userMcpAction(
            "update",
            id = "deepwiki-1",
            headers = linkedMapOf("Authorization" to "Bearer t0ken", "X-Del" to null),
        )
        assertEquals(
            """{"action":"update","id":"deepwiki-1","headers":{"Authorization":"Bearer t0ken","X-Del":null}}""",
            api.posts.single().second,
        )
        vm.userMcpAction("add", name = "s", url = "https://a.test/mcp", headers = mapOf("X-Key" to "v"))
        assertEquals(2, api.posts.size)
        assertTrue(api.posts[1].second.contains("\"headers\":{\"X-Key\":\"v\"}"))
    }

    @Test
    fun `quota error surfaces as notice and skips reload`() {
        val api = FakeUserMcpApi().apply {
            failNextPost = "quota_exceeded"
            nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST))
        }
        val vm = newVm(api)
        vm.userMcpAction("add", name = "x", url = "https://x.test/mcp")
        assertEquals("quota_exceeded", vm.state.value.notice)
        assertTrue(api.gets.isEmpty()) // no reload on failure
    }

    private companion object {
        const val NOT_AUTHED =
            """{"ok":true,"serversEnabled":true,"maxServers":5,"servers":[
              {"id":"arc-1","name":"Arc","url":"https://mcp.arctracker.io/mcp","enabled":true,
               "oauth":{"configured":true,"authorized":false},
               "health":{"ok":false,"toolCount":0,"error":"authorization_required","code":"needs_auth"}}]}"""
        const val AUTHED =
            """{"ok":true,"serversEnabled":true,"maxServers":5,"servers":[
              {"id":"arc-1","name":"Arc","url":"https://mcp.arctracker.io/mcp","enabled":true,
               "oauth":{"configured":true,"authorized":true},
               "health":{"ok":true,"toolCount":2,"error":null},
               "tools":[{"name":"search"}]}]}"""
    }

    @Test
    fun `connect needsAuth sets authUrl and polls until authorized`() {
        val api = FakeUserMcpApi().apply {
            nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(NOT_AUTHED))
            postResponses["/api/mcp/servers"] =
                ApiResult.Ok("""{"ok":true,"needsAuth":true,"authorizationUrl":"https://auth.test/authorize?x=1"}""")
        }
        val vm = SettingsViewModel(api, scope(), pollDelayMs = 1L)
        // Flip to authorized on the second poll fetch.
        var fetches = 0
        api.nextGetProvider = {
            fetches++
            ApiResult.Ok(if (fetches >= 2) AUTHED else NOT_AUTHED)
        }
        vm.userMcpConnect("arc-1")
        assertEquals("https://auth.test/authorize?x=1", vm.state.value.userMcpAuthUrl)
        // The flip happens after a poll delay (resumed off-thread) — wait for it.
        waitFor { vm.state.value.userMcpServers.single().oauth.authorized }
    }

    @Test
    fun `connect already authorized refreshes without authUrl`() {
        val api = FakeUserMcpApi().apply {
            nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(AUTHED))
            postResponses["/api/mcp/servers"] = ApiResult.Ok("""{"ok":true,"connected":true,"toolCount":2}""")
        }
        val vm = SettingsViewModel(api, scope(), pollDelayMs = 1L)
        vm.userMcpConnect("arc-1")
        assertEquals(null, vm.state.value.userMcpAuthUrl)
        assertTrue(vm.state.value.userMcpServers.single().oauth.authorized)
    }

    @Test
    fun `authUrlHandled clears the pending url`() {
        val api = FakeUserMcpApi().apply {
            nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(AUTHED))
            postResponses["/api/mcp/servers"] =
                ApiResult.Ok("""{"ok":true,"needsAuth":true,"authorizationUrl":"https://auth.test/a"}""")
        }
        val vm = SettingsViewModel(api, scope(), pollDelayMs = 1L)
        vm.userMcpConnect("arc-1") // already authorized on first poll → loop breaks at attempt 1
        vm.userMcpAuthUrlHandled()
        assertEquals(null, vm.state.value.userMcpAuthUrl)
    }

    @Test
    fun `connect error surfaces as notice`() {
        val api = FakeUserMcpApi().apply { failNextPost = "not_found" }
        val vm = SettingsViewModel(api, scope(), pollDelayMs = 1L)
        vm.userMcpConnect("nope")
        assertEquals("not_found", vm.state.value.notice)
    }

    @Test
    fun `onDone reports success and failure`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        var ok: Boolean? = null
        vm.userMcpAction("toggle", id = "deepwiki-1", onDone = { ok = it })
        assertEquals(true, ok)
        var ko: Boolean? = null
        api.failNextPost = "private_url_blocked"
        vm.userMcpAction("add", name = "x", url = "http://192.168.1.5/mcp", onDone = { ko = it })
        assertEquals(false, ko)
    }

    @Test
    fun `privateUrlsAllowed defaults true and parses false`() {
        val api = FakeUserMcpApi().apply { nextGet = mapOf("/api/mcp/servers" to ApiResult.Ok(USER_LIST)) }
        val vm = newVm(api)
        vm.loadUserMcp()
        assertTrue(vm.state.value.userMcpPrivateUrlsAllowed) // field absent in USER_LIST → default
        api.nextGet = mapOf(
            "/api/mcp/servers" to ApiResult.Ok(
                """{"ok":true,"serversEnabled":true,"privateUrlsAllowed":false,"maxServers":5,"servers":[]}""",
            ),
        )
        vm.loadUserMcp()
        assertFalse(vm.state.value.userMcpPrivateUrlsAllowed)
    }

    private fun scope() = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())

    private fun waitFor(timeoutMs: Long = 2_000, cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!cond()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("condition not met in ${timeoutMs}ms")
            Thread.sleep(10)
        }
    }
}

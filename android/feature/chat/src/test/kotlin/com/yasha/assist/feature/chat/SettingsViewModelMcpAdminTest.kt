package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.YashaApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeAdminApi : YashaApi {
    val posts = mutableListOf<Pair<String, String>>()
    val gets = mutableListOf<String>()
    var nextGet: Map<String, ApiResult<String>> = emptyMap()
    override suspend fun getJson(path: String): ApiResult<String> {
        gets += path
        return nextGet[path] ?: ApiResult.Err("not_faked")
    }

    override suspend fun postJson(path: String, body: String): ApiResult<String> {
        posts += path to body
        return if (failNextPost == null) ApiResult.Ok("{}") else {
            val code = failNextPost!!
            failNextPost = null
            ApiResult.Err(code)
        }
    }

    var failNextPost: String? = null
    override suspend fun patchJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

private val MCP_LIST =
    """{"ok":true,"mcpEnabled":true,"servers":[
      {"id":"ketch","builtin":true,"name":"ketch (web research)","url":null,"enabled":true,
       "headers":null,"disabledTools":["crawl"],
       "health":{"ok":true,"toolCount":5,"error":null},
       "tools":[{"name":"search","description":"web search"},{"name":"scrape"}]},
      {"id":"r1","builtin":false,"name":"remote","url":"https://x.test/mcp","enabled":false,
       "headers":{"Authorization":"••••"},"disabledTools":[],
       "health":{"ok":false,"toolCount":0,"error":"boom"}}]}"""

private fun newVm(api: FakeAdminApi) = SettingsViewModel(api, CoroutineScope(Dispatchers.Unconfined + SupervisorJob()))

class SettingsViewModelMcpAdminTest {
    @Test
    fun `loadAdminMcp parses global flag, builtin and remote rows`() {
        val api = FakeAdminApi().apply { nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok(MCP_LIST)) }
        val vm = newVm(api)
        vm.loadAdminMcp()
        val st = vm.state.value
        assertEquals(true, st.adminMcpEnabled)
        assertEquals(true, st.mcpLoaded)
        assertEquals(2, st.mcpServers.size)
        val ketch = st.mcpServers[0]
        assertEquals(true, ketch.builtin)
        assertEquals(5, ketch.health.toolCount)
        assertEquals(listOf("crawl"), ketch.disabledTools)
        assertEquals("web search", ketch.tools[0].description)
        assertEquals("", ketch.tools[1].description)
        val remote = st.mcpServers[1]
        assertEquals("••••", remote.headers?.get("Authorization"))
        assertEquals("boom", remote.health.error)
    }

    @Test
    fun `loadAdminMcp ignores non-admin errors and garbage`() {
        val api = FakeAdminApi()
        val vm = newVm(api)
        vm.loadAdminMcp() // Err (not admin) → untouched
        assertEquals(false, vm.state.value.mcpLoaded)
        api.nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok("nope"))
        vm.loadAdminMcp()
        assertEquals(false, vm.state.value.mcpLoaded)
    }

    @Test
    fun `global toggle posts mcp_enabled and updates state`() {
        val api = FakeAdminApi().apply { nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok(MCP_LIST)) }
        val vm = newVm(api)
        vm.loadAdminMcp()
        vm.setMcpGlobalEnabled(false)
        assertEquals("/api/admin/settings" to """{"mcp.enabled":false}""", api.posts.last())
        assertEquals(false, vm.state.value.adminMcpEnabled)
    }

    @Test
    fun `row actions post the right bodies and reload on success`() {
        val api = FakeAdminApi().apply { nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok(MCP_LIST)) }
        val vm = newVm(api)
        vm.mcpAction("toggle", id = "r1")
        assertEquals("/api/admin/mcp" to """{"action":"toggle","id":"r1"}""", api.posts.last())
        assertTrue(api.gets.contains("/api/admin/mcp")) // reload after success
        assertEquals(2, vm.state.value.mcpServers.size)

        vm.mcpAction("add", name = "My server", url = "https://a.test/mcp")
        assertEquals("""{"action":"add","name":"My server","url":"https://a.test/mcp"}""", api.posts.last().second)

        vm.mcpAction("delete", id = "r1")
        assertEquals("""{"action":"delete","id":"r1"}""", api.posts.last().second)

        vm.mcpAction("check", id = "ketch")
        assertEquals("""{"action":"check","id":"ketch"}""", api.posts.last().second)

        vm.mcpAction("update", id = "ketch", disabledTools = listOf("search", "fetch"))
        assertEquals("""{"action":"update","id":"ketch","disabledTools":["search","fetch"]}""", api.posts.last().second)
    }

    @Test
    fun `headers merge-patch serializes upserts and null deletions`() {
        val api = FakeAdminApi().apply { nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok(MCP_LIST)) }
        val vm = newVm(api)
        vm.mcpAction(
            "update",
            id = "r1",
            headers = linkedMapOf("Authorization" to "Bearer t0ken", "X-Del" to null),
        )
        assertEquals(
            """{"action":"update","id":"r1","headers":{"Authorization":"Bearer t0ken","X-Del":null}}""",
            api.posts.last().second,
        )
        vm.mcpAction("add", name = "s", url = "https://a.test/mcp", headers = mapOf("X-Key" to "v"))
        assertEquals(
            """{"action":"add","name":"s","url":"https://a.test/mcp","headers":{"X-Key":"v"}}""",
            api.posts.last().second,
        )
        vm.mcpAction("toggle", id = "r1")
        assertEquals("""{"action":"toggle","id":"r1"}""", api.posts.last().second) // omitted when null
    }

    @Test
    fun `failed action surfaces the server error code as notice, no reload`() {
        val api = FakeAdminApi().apply { nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok(MCP_LIST)) }
        val vm = newVm(api)
        val getsBefore = api.gets.size
        api.failNextPost = "private_url_blocked"
        vm.mcpAction("add", name = "x", url = "http://127.0.0.1/mcp")
        assertEquals("private_url_blocked", vm.state.value.notice)
        assertEquals(getsBefore, api.gets.size) // no reload after failure
    }

    @Test
    fun `userPrivateUrls parses from GET and toggle posts the setting`() {
        val api = FakeAdminApi().apply {
            nextGet = mapOf(
                "/api/admin/mcp" to ApiResult.Ok("""{"ok":true,"mcpEnabled":true,"userPrivateUrls":true,"servers":[]}"""),
            )
        }
        val vm = newVm(api)
        vm.loadAdminMcp()
        assertEquals(true, vm.state.value.adminMcpUserPrivateUrls)
        vm.setMcpUserPrivateUrls(false)
        assertEquals("/api/admin/settings" to """{"mcp.userPrivateUrls":false}""", api.posts.last())
        assertEquals(false, vm.state.value.adminMcpUserPrivateUrls)
    }

    @Test
    fun `onDone reports success and failure`() {
        val api = FakeAdminApi().apply { nextGet = mapOf("/api/admin/mcp" to ApiResult.Ok(MCP_LIST)) }
        val vm = newVm(api)
        var ok: Boolean? = null
        vm.mcpAction("toggle", id = "r1", onDone = { ok = it })
        assertEquals(true, ok)
        var ko: Boolean? = null
        api.failNextPost = "invalid_headers"
        vm.mcpAction("update", id = "r1", headers = mapOf("X" to "v"), onDone = { ko = it })
        assertEquals(false, ko)
    }
}

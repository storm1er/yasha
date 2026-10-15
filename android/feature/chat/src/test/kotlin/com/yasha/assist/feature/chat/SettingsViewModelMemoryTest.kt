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

private class FakeMemoryApi : YashaApi {
    val gets = mutableListOf<String>()
    var page: (String) -> ApiResult<String> = { ApiResult.Err("not_faked") }
    override suspend fun getJson(path: String): ApiResult<String> {
        gets += path
        return page(path)
    }

    override suspend fun postJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun patchJson(path: String, body: String): ApiResult<String> = ApiResult.Ok("{}")
    override suspend fun deleteJson(path: String): ApiResult<String> = ApiResult.Ok("{}")
}

private fun row(id: String, kind: String = "fact", confidence: String? = null): String {
    val conf = confidence?.let { ""","confidence":"$it"""" } ?: ""
    return """{"id":"$id","kind":"$kind","text":"t-$id","source":"explicit","pinned":false$conf}"""
}

private fun pageJson(ids: List<String>, total: Int?, hasMore: Boolean?): String {
    val totalField = total?.let { ""","total":$it""" } ?: ""
    val hasMoreField = hasMore?.let { ""","hasMore":$it""" } ?: ""
    return """{"ok":true,"memories":[${ids.joinToString(",") { row(it) }}]$totalField$hasMoreField,"userEnabled":true,"instanceEnabled":true,"card":null}"""
}

private fun newVm(api: FakeMemoryApi) =
    SettingsViewModel(api, CoroutineScope(Dispatchers.Unconfined + SupervisorJob()))

class SettingsViewModelMemoryTest {
    @Test
    fun `loadMemories requests first page and parses total + hasMore`() {
        val api = FakeMemoryApi().apply { page = { ApiResult.Ok(pageJson(listOf("a", "b"), 7, true)) } }
        val vm = newVm(api)
        vm.loadMemories()
        assertEquals("/api/memory?limit=50&offset=0", api.gets.single())
        val st = vm.state.value
        assertEquals(listOf("a", "b"), st.memories.map { it.id })
        assertEquals(7, st.memoriesTotal)
        assertTrue(st.memoriesHasMore)
    }

    @Test
    fun `loadMoreMemories requests offset=size and appends the page`() {
        val api = FakeMemoryApi()
        var first = true
        api.page = {
            if (first) {
                first = false
                ApiResult.Ok(pageJson(listOf("a", "b"), 3, true))
            } else {
                ApiResult.Ok(pageJson(listOf("c"), 3, false))
            }
        }
        val vm = newVm(api)
        vm.loadMemories()
        vm.loadMoreMemories()
        assertEquals(
            listOf("/api/memory?limit=50&offset=0", "/api/memory?limit=50&offset=2"),
            api.gets,
        )
        val st = vm.state.value
        assertEquals(listOf("a", "b", "c"), st.memories.map { it.id })
        assertEquals(3, st.memoriesTotal)
        assertFalse(st.memoriesHasMore)
    }

    @Test
    fun `loadMemories defaults hasMore false and total to page size when absent`() {
        val api = FakeMemoryApi().apply { page = { ApiResult.Ok(pageJson(listOf("a"), null, null)) } }
        val vm = newVm(api)
        vm.loadMemories()
        val st = vm.state.value
        assertEquals(1, st.memoriesTotal)
        assertFalse(st.memoriesHasMore)
    }

    @Test
    fun `loadMemories ignores error responses`() {
        val api = FakeMemoryApi() // page always Err("not_faked")
        val vm = newVm(api)
        vm.loadMemories()
        assertEquals(0, vm.state.value.memories.size)
        assertFalse(vm.state.value.memoriesHasMore)
    }

    @Test
    fun `loadMemories parses insight kind, confidence and the typed card text`() {
        val api = FakeMemoryApi()
        api.page = {
            ApiResult.Ok(
                """{"ok":true,"memories":[${row("i1", kind = "insight", confidence = "medium")},${row("i2")}],""" +
                    """"total":2,"hasMore":false,"userEnabled":true,"card":{"text":"identity: x\nrule: y","version":3}}""",
            )
        }
        val vm = newVm(api)
        vm.loadMemories()
        val st = vm.state.value
        assertEquals("insight", st.memories[0].kind)
        assertEquals("medium", st.memories[0].confidence)
        assertEquals(null, st.memories[1].confidence)
        assertEquals("identity: x\nrule: y", st.memoryProfile)
        assertEquals(3, st.memoryProfileVersion)
    }

    @Test
    fun `kind and confidence map to localized labels`() {
        assertEquals(R.string.kind_fact, memoryKindLabel("fact"))
        assertEquals(R.string.kind_preference, memoryKindLabel("preference"))
        assertEquals(R.string.kind_insight, memoryKindLabel("insight"))
        assertEquals(R.string.kind_fact, memoryKindLabel("weird-future-kind"))
        assertEquals(R.string.confidence_low, memoryConfidenceLabel("low"))
        assertEquals(R.string.confidence_medium, memoryConfidenceLabel("medium"))
        assertEquals(R.string.confidence_high, memoryConfidenceLabel("high"))
        assertEquals(R.string.confidence_low, memoryConfidenceLabel("???"))
    }
}

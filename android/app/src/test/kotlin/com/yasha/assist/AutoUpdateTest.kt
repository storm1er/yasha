package com.yasha.assist

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.ApkHashing
import com.yasha.assist.core.net.AppUpdateDto
import com.yasha.assist.core.net.AppVersionDto
import com.yasha.assist.core.net.UpdateMeta
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// The Phase C background pipeline (AutoUpdate.kt): every branch through the
// narrow AutoUpdateApi seam, with a fake clock so the build-budget and the
// 15 s poll never sleep for real.

private class FakeApi : AutoUpdateApi {
    var version: ApiResult<AppVersionDto> = ApiResult.Ok(AppVersionDto(9, "0.9.0"))
    val startQueue = ArrayDeque<ApiResult<AppUpdateDto>>()
    val statusQueue = ArrayDeque<ApiResult<AppUpdateDto>>()
    val downloadQueue = ArrayDeque<ApiResult<Unit>>()
    var startCalls = 0
    var statusCalls = 0
    var downloadedTo: File? = null
    var downloadPayload: String = "APKDATA"

    override suspend fun fetchAppVersion() = version

    override suspend fun startAppUpdate(): ApiResult<AppUpdateDto> {
        startCalls++
        return startQueue.removeFirst()
    }

    override suspend fun fetchAppUpdate(): ApiResult<AppUpdateDto> {
        statusCalls++
        return statusQueue.removeFirst()
    }

    override suspend fun downloadApk(path: String, dest: File, onFraction: (Float) -> Unit): ApiResult<Unit> {
        val r = downloadQueue.removeFirst()
        if (r is ApiResult.Ok) {
            downloadedTo = dest
            dest.writeText(downloadPayload)
        }
        return r
    }
}

class AutoUpdateTest {
    private lateinit var dir: File
    private lateinit var shaApkData: String

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("auto-update").toFile()
        val src = File(dir, "hash-src.apk")
        src.writeText("APKDATA")
        shaApkData = ApkHashing.sha256(src)!!
        src.delete()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private val readyDto get() = ApiResult.Ok(
        AppUpdateDto(state = "ready", downloadUrl = "/d/tok", sha256 = shaApkData),
    )

    private fun run(api: FakeApi, budget: Long = 600_000, clockStep: Long = 1_000): AutoUpdateOutcome {
        var clock = 0L
        return runBlocking {
            runAutoUpdate(
                api = api,
                version = AppVersionDto(9, "0.9.0"),
                cacheDir = dir,
                budgetMs = budget,
                now = { clock },
                sleep = { clock += it + clockStep },
            )
        }
    }

    @Test
    fun `ready immediately - download, verify, write the meta`() {
        val api = FakeApi()
        api.startQueue.add(readyDto)
        api.downloadQueue.add(ApiResult.Ok(Unit))
        assertEquals(AutoUpdateOutcome.Ready, run(api))
        val meta = UpdateMeta.read(dir)!!
        assertEquals(9, meta.versionCode)
        assertEquals("0.9.0", meta.versionName)
        assertEquals(ApkHashing.sha256(UpdateMeta.apkFile(dir)), meta.sha256)
    }

    @Test
    fun `a still-valid pending artifact short-circuits everything`() {
        val apk = UpdateMeta.apkFile(dir)
        apk.writeText("APKDATA")
        UpdateMeta.write(dir, UpdateMeta(9, "0.9.0", ApkHashing.sha256(apk)!!))
        val api = FakeApi()
        assertEquals(AutoUpdateOutcome.Ready, run(api))
        assertEquals(0, api.startCalls)
    }

    @Test
    fun `a corrupted pending artifact is replaced by a fresh download`() {
        UpdateMeta.apkFile(dir).writeText("TRUNCATED")
        UpdateMeta.write(dir, UpdateMeta(9, "0.9.0", "0000"))
        val api = FakeApi()
        api.startQueue.add(readyDto)
        api.downloadQueue.add(ApiResult.Ok(Unit))
        assertEquals(AutoUpdateOutcome.Ready, run(api))
        assertEquals(1, api.startCalls)
        assertTrue(pendingVerifiedApk(dir) != null)
    }

    @Test
    fun `meta with an empty checksum never counts as verified`() {
        UpdateMeta.apkFile(dir).writeText("APKDATA")
        UpdateMeta.write(dir, UpdateMeta(9, "0.9.0", ""))
        assertNull(pendingVerifiedApk(dir))
    }

    @Test
    fun `polls while building, succeeds when the build lands`() {
        val api = FakeApi()
        api.startQueue.add(ApiResult.Ok(AppUpdateDto(state = "building")))
        api.statusQueue.add(ApiResult.Ok(AppUpdateDto(state = "queued")))
        api.statusQueue.add(readyDto)
        api.downloadQueue.add(ApiResult.Ok(Unit))
        assertEquals(AutoUpdateOutcome.Ready, run(api))
        assertEquals(2, api.statusCalls)
    }

    @Test
    fun `still building when the budget runs out - Building (retry later)`() {
        val api = FakeApi()
        api.startQueue.add(ApiResult.Ok(AppUpdateDto(state = "building")))
        repeat(100) { api.statusQueue.add(ApiResult.Ok(AppUpdateDto(state = "building"))) }
        val outcome = run(api, budget = 60_000, clockStep = 0)
        assertEquals(AutoUpdateOutcome.Building, outcome)
        // 60 s budget / 15 s poll — bounded, and far below the 100 queued rows.
        assertTrue("polls=${api.statusCalls}", api.statusCalls in 3..4)
    }

    @Test
    fun `server build failure ends the attempt`() {
        val api = FakeApi()
        api.startQueue.add(ApiResult.Ok(AppUpdateDto(state = "failed", error = "gradle_failed")))
        assertEquals(AutoUpdateOutcome.Failed, run(api))
    }

    @Test
    fun `ready without a link is a failure`() {
        val api = FakeApi()
        api.startQueue.add(ApiResult.Ok(AppUpdateDto(state = "ready")))
        assertEquals(AutoUpdateOutcome.Failed, run(api))
    }

    @Test
    fun `start and poll transport errors map to Failed`() {
        val startErr = FakeApi().apply { startQueue.add(ApiResult.Err("app_updates_disabled")) }
        assertEquals(AutoUpdateOutcome.Failed, run(startErr))

        val pollErr = FakeApi()
        pollErr.startQueue.add(ApiResult.Ok(AppUpdateDto(state = "queued")))
        pollErr.statusQueue.add(ApiResult.Err("network"))
        assertEquals(AutoUpdateOutcome.Failed, run(pollErr))
    }

    @Test
    fun `download failure deletes the partial file`() {
        val api = FakeApi()
        api.startQueue.add(readyDto)
        api.downloadQueue.add(ApiResult.Err("network"))
        assertEquals(AutoUpdateOutcome.Failed, run(api))
        assertFalse(UpdateMeta.apkFile(dir).exists())
    }

    @Test
    fun `checksum mismatch discards the artifact and any stale meta`() {
        val api = FakeApi()
        api.startQueue.add(readyDto)
        api.downloadQueue.add(ApiResult.Ok(Unit))
        api.downloadPayload = "CORRUPTED"
        assertEquals(AutoUpdateOutcome.Failed, run(api))
        assertFalse(UpdateMeta.apkFile(dir).exists())
        assertNull(UpdateMeta.read(dir))
    }

    @Test
    fun `a server without a checksum still accepts the download`() {
        val api = FakeApi()
        api.startQueue.add(ApiResult.Ok(AppUpdateDto(state = "ready", downloadUrl = "/d/tok")))
        api.downloadQueue.add(ApiResult.Ok(Unit))
        assertEquals(AutoUpdateOutcome.Ready, run(api))
        val meta = UpdateMeta.read(dir)!!
        assertEquals(ApkHashing.sha256(UpdateMeta.apkFile(dir)), meta.sha256)
    }
}

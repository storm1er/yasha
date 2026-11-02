package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.AppUpdateDto
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// UpdateController (issue #34 Phase B): policy coverage for the update flow —
// poll/backoff, 410→re-build, checksum failure, network retries, the install
// permission gate, backgrounded launch deferral and the abort/conflict UX —
// all through the two seams, on an unconfined scope (no virtual time needed:
// the delays fake returns instantly).

private class FakeTransport : UpdateTransport {
    val startQueue = ArrayDeque<ApiResult<AppUpdateDto>>()
    val statusQueue = ArrayDeque<ApiResult<AppUpdateDto>>()
    val downloadQueue = ArrayDeque<ApiResult<Unit>>()
    val shaQueue = ArrayDeque<String?>()
    var startCalls = 0
    var sha: String? = null
    var shaCalls = 0
    var lastUrl: String? = null

    override suspend fun start(): ApiResult<AppUpdateDto> {
        startCalls++
        return startQueue.removeFirst()
    }

    override suspend fun status(): ApiResult<AppUpdateDto> = statusQueue.removeFirst()

    override suspend fun download(url: String, dest: File, onFraction: (Float) -> Unit): ApiResult<Unit> {
        lastUrl = url
        onFraction(1f)
        return downloadQueue.removeFirst()
    }

    override fun sha256(dest: File): String? {
        shaCalls++
        return if (shaQueue.isNotEmpty()) shaQueue.removeFirst() else sha
    }
}

private class FakeGateway : ApkInstallGateway {
    var permission = true
    var openCount = 0
    var launches = 0
    var launchReturns = true
    var pendingResult: ((InstallOutcome) -> Unit)? = null

    override fun hasInstallPermission() = permission
    override fun openPermissionSettings() {
        openCount++
    }

    override fun launchInstall(dest: File, onResult: (InstallOutcome) -> Unit): Boolean {
        launches++
        pendingResult = onResult
        return launchReturns
    }
}

class FakeDelays : UpdateController.PollDelay() {
    val polls = mutableListOf<Int>()
    var retries = 0
    override suspend fun poll(attempt: Int) {
        polls += attempt
    }

    override suspend fun retry(n: Int) {
        retries++
    }
}

class UpdateControllerTest {
    private val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
    private val apk = File.createTempFile("yasha-update-test", ".apk").apply { writeBytes(byteArrayOf(1)) }
    private val published = mutableListOf<UpdateFlow?>()
    private var successes = 0

    @After
    fun tearDown() {
        scope.cancel()
        apk.delete()
    }

    private fun controller(
        transport: FakeTransport,
        gateway: FakeGateway,
        delays: FakeDelays = FakeDelays(),
    ): UpdateController = UpdateController(
        transport = transport,
        installer = gateway,
        scope = scope,
        apkFile = apk,
        publish = { published += it },
        onSuccess = { successes++ },
        delays = delays,
    )

    private val ready = AppUpdateDto(state = "ready", downloadUrl = "/d/tok", sha256 = "abc123")

    @Test
    fun `pollDelayMs climbs 5s steps capped at 30s`() {
        assertEquals(listOf(5_000L, 10_000L, 15_000L, 20_000L, 25_000L, 30_000L, 30_000L), (0..6).map { pollDelayMs(it) })
    }

    @Test
    fun `happy path queued - building - ready - download - verified - installer`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(AppUpdateDto(state = "queued"))
            statusQueue += ApiResult.Ok(AppUpdateDto(state = "building"))
            statusQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        controller(t, g).start()
        assertEquals(listOf(UpdatePhase.Building, UpdatePhase.Downloading, UpdatePhase.LaunchingInstaller), published.mapNotNull { it?.phase })
        assertEquals(1, g.launches)
        assertEquals("/d/tok", t.lastUrl)
        g.pendingResult!!(InstallOutcome.Success)
        assertEquals(1, successes)
    }

    @Test
    fun `checksum mismatch deletes the file and re-queues a fresh build + link`() {
        val t = FakeTransport().apply {
            repeat(2) { startQueue += ApiResult.Ok(ready) }
            downloadQueue += ApiResult.Ok(Unit) // first cycle: bad bytes on disk
            downloadQueue += ApiResult.Ok(Unit)
            shaQueue += "WRONG"
            sha = "abc123"
        }
        val g = FakeGateway()
        controller(t, g).start()
        assertEquals(2, t.startCalls)
        assertEquals(UpdatePhase.LaunchingInstaller, published.last()?.phase)
        assertEquals(1, g.launches) // only the verified cycle reaches the installer
    }

    @Test
    fun `expired link (410) re-queues without touching checksums`() {
        val t = FakeTransport().apply {
            repeat(2) { startQueue += ApiResult.Ok(ready) }
            downloadQueue += ApiResult.Err("expired")
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        controller(t, g).start()
        assertEquals(2, t.startCalls)
        assertEquals(UpdatePhase.LaunchingInstaller, published.last()?.phase)
    }

    @Test
    fun `idle under a queued build (row swept) re-queues once`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(AppUpdateDto(state = "queued"))
            startQueue += ApiResult.Ok(ready)
            statusQueue += ApiResult.Ok(AppUpdateDto(state = "idle"))
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        controller(t, FakeGateway()).start()
        assertEquals(2, t.startCalls)
        assertEquals(UpdatePhase.LaunchingInstaller, published.last()?.phase)
    }

    @Test
    fun `network failures retry then surface as download failure`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            repeat(3) { downloadQueue += ApiResult.Err("network") }
        }
        val c = controller(t, FakeGateway())
        c.start()
        val last = published.last()!!
        assertEquals(UpdatePhase.Failed, last.phase)
        assertEquals("download", last.error)
    }

    @Test
    fun `poll budget exhausted → timeout`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(AppUpdateDto(state = "queued"))
            repeat(4) { statusQueue += ApiResult.Ok(AppUpdateDto(state = "building")) }
        }
        val delays = FakeDelays().apply { pollAttempts = 2 }
        val c = controller(t, FakeGateway(), delays)
        c.start()
        assertEquals(listOf(0, 1), delays.polls)
        val last = published.last()!!
        assertEquals(UpdatePhase.Failed, last.phase)
        assertEquals("timeout", last.error)
    }

    @Test
    fun `server build failure surfaces its error`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(AppUpdateDto(state = "queued"))
            statusQueue += ApiResult.Ok(AppUpdateDto(state = "failed", error = "gradle_failed (exit 1): boom"))
        }
        controller(t, FakeGateway()).start()
        val last = published.last()!!
        assertEquals(UpdatePhase.Failed, last.phase)
        assertEquals("gradle_failed (exit 1): boom", last.error)
    }

    @Test
    fun `start call failure surfaces the error code`() {
        val t = FakeTransport().apply { startQueue += ApiResult.Err("trusted_origins_unset") }
        controller(t, FakeGateway()).start()
        assertEquals("trusted_origins_unset", published.last()!!.error)
    }

    @Test
    fun `download without a checksum (old server) is accepted`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(AppUpdateDto(state = "ready", downloadUrl = "/d/legacy"))
            downloadQueue += ApiResult.Ok(Unit)
            sha = null
        }
        controller(t, FakeGateway()).start()
        assertEquals(UpdatePhase.LaunchingInstaller, published.last()?.phase)
    }

    @Test
    fun `permission gate NeedPermission - grant - onResume launches`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway().apply { permission = false }
        val c = controller(t, g)
        c.start()
        assertEquals(UpdatePhase.NeedPermission, published.last()?.phase)
        assertEquals(0, g.launches)
        c.onResume() // still not granted → stays on NeedPermission
        assertEquals(0, g.launches)
        g.permission = true
        c.onResume()
        assertEquals(1, g.launches)
        assertEquals(UpdatePhase.LaunchingInstaller, published.last()?.phase)
    }

    @Test
    fun `backgrounded commit defers to ReadyToInstall and relaunches on resume`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway().apply { launchReturns = false }
        val c = controller(t, g)
        c.start()
        assertEquals(UpdatePhase.ReadyToInstall, published.last()?.phase)
        g.launchReturns = true
        c.onResume()
        assertEquals(2, g.launches)
        assertEquals(UpdatePhase.LaunchingInstaller, published.last()?.phase)
    }

    @Test
    fun `user abort of the system prompt keeps ReadyToInstall without error`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        val c = controller(t, g)
        c.start()
        g.pendingResult!!(InstallOutcome.Aborted)
        assertEquals(UpdatePhase.ReadyToInstall, published.last()?.phase)
        assertEquals(0, successes)
    }

    @Test
    fun `abort then resume does not re-push the prompt and explicit launch does`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        val c = controller(t, g)
        c.start()
        assertEquals(1, g.launches)
        g.pendingResult!!(InstallOutcome.Aborted)
        // Activity resumes (returning from the dismissed installer): must stay quiet.
        c.onResume()
        c.onResume()
        assertEquals(1, g.launches)
        // The dialog's Install button is the only thing that reopens the prompt.
        c.launch()
        assertEquals(2, g.launches)
    }

    @Test
    fun `signature conflict surfaces as conflict and clears the stale apk`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        controller(t, g).start()
        g.pendingResult!!(InstallOutcome.Conflict)
        val last = published.last()!!
        assertEquals(UpdatePhase.Failed, last.phase)
        assertEquals("conflict", last.error)
        assertFalse(apk.exists())
    }

    @Test
    fun `install failure surfaces as install_failed`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        controller(t, g).start()
        g.pendingResult!!(InstallOutcome.Failure)
        assertEquals("install_failed", published.last()!!.error)
    }

    @Test
    fun `cancel publishes null and removes the partially downloaded apk`() {
        val t = FakeTransport().apply {
            startQueue += ApiResult.Ok(ready)
            downloadQueue += ApiResult.Ok(Unit)
            sha = "abc123"
        }
        val g = FakeGateway()
        val c = controller(t, g)
        c.start()
        assertTrue(apk.exists())
        c.cancel()
        assertNull(published.last())
        assertFalse(apk.exists())
    }

    @Test
    fun `launch is a no-op before an apk is ready`() {
        val g = FakeGateway()
        controller(FakeTransport(), g).launch()
        assertEquals(0, g.launches)
    }
}

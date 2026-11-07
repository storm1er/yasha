package com.yasha.assist.feature.chat

import com.yasha.assist.core.audio.MicRecorder
import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.AppUpdateDto
import com.yasha.assist.core.net.AppVersionDto
import com.yasha.assist.core.net.AttachmentLimitsDto
import com.yasha.assist.core.net.AudioConfigDto
import com.yasha.assist.core.net.ChatEvent
import com.yasha.assist.core.net.ChatRequestBody
import com.yasha.assist.core.net.ModelsDto
import com.yasha.assist.core.net.SessionAccess
import com.yasha.assist.core.net.SessionProbe
import com.yasha.assist.core.net.ThreadDetailDto
import com.yasha.assist.core.net.ThreadRowDto
import com.yasha.assist.core.net.UpdateMeta
import com.yasha.assist.core.net.YashaChatApi
import com.yasha.assist.core.net.ApkHashing
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Issue #14 regression suite: the startup session probe must clear the stored
// token ONLY when the server confirmed the sign-out — a transport failure
// (airplane mode) keeps the session and drives the offline banner instead.
// Same fake-driven pattern as the SettingsViewModel tests (no Robolectric).

private val UnusedRecorder = object : MicRecorder {
    override fun start(): Boolean = false
    override fun stopWav(): ByteArray? = null
    override fun cancel() {}
}

private class FakeStore : SessionAccess {
    override var baseUrl: String = "https://yasha.test"
    override var token: String? = "seeded-token"
    override var email: String? = "user@yasha.test"
    override var dismissedUpdateCode: Int = 0
    override var autoDownloadWifi: Boolean = false
    var clearCount = 0
    override fun signedIn() = !token.isNullOrEmpty()
    override fun clearSession() { clearCount++; token = null }
}

private class FakeChatApi(probes: List<SessionProbe>) : YashaChatApi {
    private val queue = probes.toMutableList()
    var probeCount = 0
    var refreshCount = 0
    override suspend fun probeSession(): SessionProbe {
        probeCount++
        return queue.removeAt(0)
    }
    override suspend fun signIn(identifier: String, password: String): ApiResult<Unit> = ApiResult.Ok(Unit)
    override suspend fun signOut() {}
    var defaultModel: String? = "server-default"
    override suspend fun fetchModels(): ApiResult<ModelsDto> { refreshCount++; return ApiResult.Ok(ModelsDto(emptyList(), default = defaultModel)) }
    // Issue #69: records every warm trigger (the effective model id).
    val warmCalls = mutableListOf<String?>()
    override suspend fun warmBackend(model: String?): ApiResult<String> { warmCalls += model; return ApiResult.Ok("{}") }
    override suspend fun listThreads(): ApiResult<List<ThreadRowDto>> = ApiResult.Ok(emptyList())
    override suspend fun openThread(id: String): ApiResult<ThreadDetailDto> = ApiResult.Err("not_faked")
    override suspend fun deleteThread(id: String): ApiResult<Unit> = ApiResult.Ok(Unit)
    override suspend fun audioConfig(): ApiResult<AudioConfigDto> = ApiResult.Err("not_faked")
    var limits: ApiResult<AttachmentLimitsDto> = ApiResult.Err("not_faked")
    override suspend fun attachmentLimits(): ApiResult<AttachmentLimitsDto> = limits
    var appVersion: ApiResult<AppVersionDto> = ApiResult.Err("not_faked")
    override suspend fun fetchAppVersion(): ApiResult<AppVersionDto> = appVersion
    override suspend fun fetchAppUpdate(): ApiResult<AppUpdateDto> = ApiResult.Err("not_faked")
    var appUpdateStart: ApiResult<AppUpdateDto> = ApiResult.Err("not_faked")
    override suspend fun startAppUpdate(): ApiResult<AppUpdateDto> = appUpdateStart
    override suspend fun downloadApk(path: String, dest: java.io.File, onFraction: (Float) -> Unit): ApiResult<Unit> =
        ApiResult.Err("not_faked")
    override suspend fun retryTranscribe(messageId: String): ApiResult<Boolean> = ApiResult.Err("not_faked")
    override fun chatStream(body: ChatRequestBody): Flow<ChatEvent> = emptyFlow()
}

class ChatViewModelSessionTest {
    private val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
    // The reconnect "timer": each send() lets the background loop run one probe.
    private val tick = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.UNLIMITED)

    @After
    fun tearDown() { scope.cancel() }

    private fun newVm(store: FakeStore, api: FakeChatApi) = ChatViewModel(
        store,
        api,
        recorderFactory = { UnusedRecorder },
        reconnectDelay = { tick.receive() },
        testScope = scope,
    )

    @Test
    fun `network failure keeps the stored session and shows the offline banner`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Unreachable, SessionProbe.Unreachable))
        val vm = newVm(store, api)
        vm.start()
        // The regression: a transport failure must NEVER destroy the token
        // (unrecoverable for credential-seeded APKs, which never re-seed).
        assertEquals(0, store.clearCount)
        assertEquals("seeded-token", store.token)
        assertTrue(vm.state.value.signedIn)
        assertTrue(vm.state.value.offline)
        assertFalse(vm.state.value.checkingSession)
    }

    @Test
    fun `server-confirmed invalid session clears the token and signs out`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Invalid))
        val vm = newVm(store, api)
        vm.start()
        assertEquals(1, store.clearCount)
        assertFalse(vm.state.value.signedIn)
        assertFalse(vm.state.value.offline)
    }

    @Test
    fun `valid session enters the app and refreshes`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        val vm = newVm(store, api)
        vm.start()
        assertTrue(vm.state.value.signedIn)
        assertFalse(vm.state.value.offline)
        assertEquals(0, store.clearCount)
        assertEquals(1, api.refreshCount)
    }

    // Issue #69: entering the app (valid probe) warms the backend once with
    // the effective default model; nothing else may re-fire it.
    @Test
    fun `app open warms the backend with the effective default model`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        val vm = newVm(FakeStore(), api)
        vm.start()
        assertEquals(listOf<String?>("server-default"), api.warmCalls)
    }

    @Test
    fun `later refreshes never re-warm`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        val vm = newVm(FakeStore(), api)
        vm.start()
        vm.refresh()
        vm.retryNow() // not offline → plain refresh
        assertEquals(1, api.warmCalls.size)
    }

    @Test
    fun `offline and invalid entries never warm`() {
        val offlineApi = FakeChatApi(listOf(SessionProbe.Unreachable))
        newVm(FakeStore(), offlineApi).start()
        val invalidApi = FakeChatApi(listOf(SessionProbe.Invalid))
        newVm(FakeStore(), invalidApi).start()
        assertEquals(emptyList<String?>(), offlineApi.warmCalls)
        assertEquals(emptyList<String?>(), invalidApi.warmCalls)
    }

    @Test
    fun `offline auto-recovers on the next background probe without clearing the token`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Unreachable, SessionProbe.Valid))
        val vm = newVm(store, api)
        vm.start()
        assertTrue(vm.state.value.offline)
        tick.trySend(Unit)
        assertFalse(vm.state.value.offline)
        assertTrue(vm.state.value.signedIn)
        assertEquals(0, store.clearCount)
        assertEquals(1, api.refreshCount)
    }

    @Test
    fun `retryNow re-probes immediately while offline and stops the loop`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Unreachable, SessionProbe.Valid))
        val vm = newVm(store, api)
        vm.start()
        assertTrue(vm.state.value.offline)
        vm.retryNow()
        assertEquals(2, api.probeCount)
        assertFalse(vm.state.value.offline)
        // Any pending delayed probe was cancelled: no third probe can fire.
        tick.trySend(Unit)
        assertEquals(2, api.probeCount)
    }

    @Test
    fun `resume while offline re-probes immediately`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Unreachable, SessionProbe.Valid))
        val vm = newVm(store, api)
        vm.start()
        assertTrue(vm.state.value.offline)
        vm.onResume()
        assertFalse(vm.state.value.offline)
        assertEquals(0, store.clearCount)
    }

    @Test
    fun `no stored token shows the login screen without probing`() {
        val store = FakeStore().apply { token = null }
        val api = FakeChatApi(emptyList())
        val vm = newVm(store, api)
        vm.start()
        assertEquals(0, api.probeCount)
        assertFalse(vm.state.value.signedIn)
        assertFalse(vm.state.value.offline)
    }

    // Issue #15: the composer mirrors the admin-configured attachment caps.
    @Test
    fun `refresh adopts the server attachment cap`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.limits = ApiResult.Ok(AttachmentLimitsDto(maxImagesPerMessage = 1, maxWindowImages = 8, maxUploadBytes = 4096))
        val vm = newVm(FakeStore(), api)
        vm.start()
        vm.refresh()
        assertEquals(1, vm.state.value.maxAttachments)
    }

    @Test
    fun `attachment cap fetch failure keeps the client default`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid)) // limits stays Err("not_faked")
        val vm = newVm(FakeStore(), api)
        vm.start()
        vm.refresh()
        assertEquals(ChatUiState.MAX_ATTACHMENTS, vm.state.value.maxAttachments)
    }

    // Issue #34 (Phase A): update channel — banner, dismissal memory, manual check.
    @Test
    fun `cold start with a newer server build raises the banner`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 9, versionName = "9.9.9"))
        val vm = newVm(FakeStore(), api)
        vm.start()
        assertEquals("9.9.9", vm.state.value.updateVersionName)
    }

    @Test
    fun `dismiss silences the code and a strictly newer one raises the banner again`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 9, versionName = "9.9.9"))
        val vm = newVm(store, api)
        vm.start()
        vm.dismissUpdate()
        assertNull(vm.state.value.updateVersionName)
        assertEquals(9, store.dismissedUpdateCode)
        vm.refresh() // same code stays silenced
        assertNull(vm.state.value.updateVersionName)
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 10, versionName = "0.3.0"))
        vm.refresh()
        assertEquals("0.3.0", vm.state.value.updateVersionName)
    }

    @Test
    fun `manual check reports up-to-date versus the available version`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 1, versionName = "0.2.9"))
        val vm = newVm(FakeStore(), api)
        vm.start()
        vm.checkForUpdates()
        assertEquals("up_to_date", vm.state.value.updateCheckResult)
        assertNull(vm.state.value.updateVersionName)
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 4, versionName = "0.4.0"))
        vm.checkForUpdates()
        assertEquals("0.4.0", vm.state.value.updateCheckResult)
        assertEquals("0.4.0", vm.state.value.updateVersionName)
    }

    // Issue #34 (Phase B): the flow only exists with the installer seams wired.
    @Test
    fun `update flow stays inert without an installer gateway`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        val vm = newVm(FakeStore(), api)
        vm.start()
        vm.startUpdate()
        vm.launchUpdateInstall()
        vm.resumeUpdateFlow()
        vm.cancelUpdate()
        assertNull(vm.state.value.updateFlow)
    }

    @Test
    fun `startUpdate with a gateway runs the flow through the client`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appUpdateStart = ApiResult.Err("trusted_origins_unset")
        val store = FakeStore()
        val gateway = object : ApkInstallGateway {
            override fun hasInstallPermission() = true
            override fun openPermissionSettings() {}
            override fun launchInstall(dest: java.io.File, onResult: (InstallOutcome) -> Unit) = true
        }
        val apk = java.io.File.createTempFile("vm-update", ".apk")
        try {
            val vm = ChatViewModel(
                store,
                api,
                apkGateway = gateway,
                apkFile = apk,
                recorderFactory = { UnusedRecorder },
                reconnectDelay = { tick.receive() },
                testScope = scope,
            )
            vm.start()
            vm.startUpdate()
            // Unconfined scope: the flow ran to its terminal publish synchronously.
            assertEquals(UpdatePhase.Failed, vm.state.value.updateFlow?.phase)
            assertEquals("trusted_origins_unset", vm.state.value.updateFlow?.error)
            // "Later" clears the flow banner state too.
            vm.dismissUpdate()
            assertNull(vm.state.value.updateFlow)
        } finally {
            apk.delete()
        }
    }

    // Issue #34 (Phase C): notes, kill-switch, Wi-Fi pref, notification entry.
    @Test
    fun `banner check carries the release notes`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appVersion = ApiResult.Ok(AppVersionDto(9, "9.9.9", notes = "- shiny thing"))
        val vm = newVm(FakeStore(), api)
        vm.start()
        assertEquals("- shiny thing", vm.state.value.updateNotes)
    }

    @Test
    fun `the admin kill-switch takes the banner down and names the code`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 9, versionName = "9.9.9"))
        val vm = newVm(FakeStore(), api)
        vm.start()
        assertEquals("9.9.9", vm.state.value.updateVersionName)
        api.appVersion = ApiResult.Err("app_updates_disabled")
        vm.checkForUpdates()
        assertNull(vm.state.value.updateVersionName)
        assertEquals("error:app_updates_disabled", vm.state.value.updateCheckResult)
    }

    @Test
    fun `an up-to-date check clears a stale auto-download artifact`() {
        val dir = java.nio.file.Files.createTempDirectory("vm-upd").toFile()
        try {
            val api = FakeChatApi(listOf(SessionProbe.Valid))
            api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 1, versionName = "0.2.9"))
            java.io.File(dir, UpdateMeta.APK_NAME).writeText("STALE")
            UpdateMeta.write(dir, UpdateMeta(99, "9.9", "deadbeef"))
            val vm = ChatViewModel(
                FakeStore(),
                api,
                installedVersionCode = 1,
                apkFile = java.io.File(dir, UpdateMeta.APK_NAME),
                recorderFactory = { UnusedRecorder },
                testScope = scope,
            )
            vm.start()
            assertNull(UpdateMeta.read(dir))
            assertFalse(java.io.File(dir, UpdateMeta.APK_NAME).exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `the auto-download pref mirrors the store and the state`() {
        val store = FakeStore()
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        val vm = newVm(store, api)
        vm.start()
        assertFalse(vm.state.value.autoDownloadWifi)
        vm.setAutoDownloadWifi(true)
        assertTrue(store.autoDownloadWifi)
        assertTrue(vm.state.value.autoDownloadWifi)
    }

    @Test
    fun `notification tap primes the verified apk straight to ReadyToInstall`() {
        val dir = java.nio.file.Files.createTempDirectory("vm-prime").toFile()
        try {
            val api = FakeChatApi(listOf(SessionProbe.Valid))
            val apk = java.io.File(dir, UpdateMeta.APK_NAME)
            apk.writeText("APKDATA")
            val sha = ApkHashing.sha256(apk)!!
            UpdateMeta.write(dir, UpdateMeta(9, "0.9.0", sha.uppercase()))
            val gateway = object : ApkInstallGateway {
                override fun hasInstallPermission() = true
                override fun openPermissionSettings() {}
                override fun launchInstall(dest: java.io.File, onResult: (InstallOutcome) -> Unit) = true
            }
            val vm = ChatViewModel(
                FakeStore(),
                api,
                installedVersionCode = 1,
                apkGateway = gateway,
                apkFile = apk,
                recorderFactory = { UnusedRecorder },
                reconnectDelay = { tick.receive() },
                testScope = scope,
            )
            vm.start()
            vm.onUpdateNotification(ready = true)
            assertTrue(vm.state.value.openUpdateTick > 0L)
            assertEquals(UpdatePhase.ReadyToInstall, vm.state.value.updateFlow?.phase)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `notification tap opens the updater and tops up a failed banner check`() {
        val api = FakeChatApi(listOf(SessionProbe.Valid))
        api.appVersion = ApiResult.Err("network") // auto-check at start finds nothing
        val vm = newVm(FakeStore(), api)
        vm.start()
        assertNull(vm.state.value.updateVersionName)
        api.appVersion = ApiResult.Ok(AppVersionDto(versionCode = 8, versionName = "8.0.0"))
        vm.onUpdateNotification(ready = false)
        assertEquals("8.0.0", vm.state.value.updateVersionName)
        assertTrue(vm.state.value.openUpdateTick > 0L)
    }
}

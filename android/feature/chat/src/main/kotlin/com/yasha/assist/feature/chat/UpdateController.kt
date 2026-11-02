package com.yasha.assist.feature.chat

import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.AppUpdateDto
import com.yasha.assist.core.net.YashaChatApi
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// In-app update flow (issue #34, Phase B): the pure state machine behind the
// Update dialog. Everything effectful hides behind two seams — UpdateTransport
// (server) and ApkInstallGateway (PackageInstaller) — so the whole policy
// (poll backoff, 410→re-build, checksum, permission gate, background→deferred
// launch, abort/conflict UX) is JVM-testable.

enum class UpdatePhase { Building, Downloading, ReadyToInstall, NeedPermission, LaunchingInstaller, Failed }

/** What the dialog renders; `error` (a stable code) rides Failed. */
data class UpdateFlow(val phase: UpdatePhase, val progress: Float = 0f, val error: String? = null)

interface UpdateTransport {
    suspend fun start(): ApiResult<AppUpdateDto>
    suspend fun status(): ApiResult<AppUpdateDto>
    suspend fun download(url: String, dest: File, onFraction: (Float) -> Unit): ApiResult<Unit>
    fun sha256(dest: File): String?
}

enum class InstallOutcome { Success, Aborted, Conflict, Failure }

interface ApkInstallGateway {
    fun hasInstallPermission(): Boolean
    fun openPermissionSettings()
    /**
     * Streams [dest] into a PackageInstaller session and commits with a status
     * PendingIntent. Returns false when the commit cannot be launched right
     * now (app in background) — the caller stays ReadyToInstall and retries on
     * resume. [onResult] fires once from the status receiver.
     */
    fun launchInstall(dest: File, onResult: (InstallOutcome) -> Unit): Boolean
}

class ClientUpdateTransport(private val client: YashaChatApi) : UpdateTransport {
    override suspend fun start(): ApiResult<AppUpdateDto> = client.startAppUpdate()
    override suspend fun status(): ApiResult<AppUpdateDto> = client.fetchAppUpdate()
    override suspend fun download(url: String, dest: File, onFraction: (Float) -> Unit): ApiResult<Unit> =
        client.downloadApk(url, dest, onFraction)

    override fun sha256(dest: File): String? = com.yasha.assist.core.net.ApkHashing.sha256(dest)
}

/** 5 s, 10 s, … capped at 30 s (issue #34 §B2). Pure — directly tested. */
fun pollDelayMs(attempt: Int): Long = (5_000L * (attempt + 1)).coerceAtMost(30_000L)

class UpdateController(
    private val transport: UpdateTransport,
    private val installer: ApkInstallGateway,
    private val scope: CoroutineScope,
    private val apkFile: File,
    private val publish: (UpdateFlow?) -> Unit,
    /** Install confirmed (the process dies shortly after; clear the banner). */
    private val onSuccess: () -> Unit,
    /** User can drive again from a clean dialog (transient failure paths). */
    private val delays: PollDelay = PollDelay(),
) {
    // Split out so tests replace only the waiting, never the policy.
    open class PollDelay {
        var pollAttempts: Int = 24 // ≈ 10 min total with pollDelayMs()
        var netRetries: Int = 3
        var cycles: Int = 3 // start→poll→download attempts (410/checksum requeue)
        open suspend fun poll(attempt: Int) = delay(pollDelayMs(attempt))
        open suspend fun retry(n: Int) = delay(1_000L shl n) // 1 s, 2 s, 4 s
    }

    private var job: Job? = null
    private var readyToInstall = false
    // A PackageInstaller session is committed and its status receiver is
    // waiting — no second commit until that resolves (guards resume re-entry).
    private var installInFlight = false

    // Automatic commits: right after the verified download, on the permission
    // round-trip return, and after a backgrounded finish. Cleared once the user
    // ABORTS the system prompt — resuming then must NOT push the prompt again;
    // only an explicit Install tap retries (issue #34 §abort UX).
    private var autoLaunch = false

    fun start() {
        job?.cancel()
        readyToInstall = false
        installInFlight = false
        autoLaunch = false
        job = scope.launch { runCycles() }
    }

    fun cancel() {
        job?.cancel()
        job = null
        readyToInstall = false
        installInFlight = false
        autoLaunch = false
        apkFile.delete()
        publish(null)
    }

    /**
     * Try to hand the verified APK to the installer. Called on the verified
     * download, the dialog's Install button, and (guarded) onResume. An
     * explicit tap is a user override and always re-commits — a system prompt
     * that never returns a status (e.g. Play Protect silently blocking) must
     * not leave the button dead. A false-returning gateway (app backgrounded)
     * keeps ReadyToInstall so the next resume retries.
     */
    fun launch() {
        if (!readyToInstall) return
        if (!installer.hasInstallPermission()) {
            publish(UpdateFlow(UpdatePhase.NeedPermission))
            return
        }
        val started = installer.launchInstall(apkFile) { outcome -> scope.launch { handleInstall(outcome) } }
        if (started) installInFlight = true
        publish(UpdateFlow(if (started) UpdatePhase.LaunchingInstaller else UpdatePhase.ReadyToInstall))
    }

    /** Activity resumed: nudge a pending permission or a deferred launch — but
     * never re-open a prompt the user just dismissed, and never double-commit
     * one still awaiting its status. */
    fun onResume() {
        if (readyToInstall && autoLaunch && !installInFlight) launch()
    }

    private suspend fun runCycles() {
        repeat(delays.cycles) {
            when (runCycle()) {
                CycleOutcome.Done -> return
                CycleOutcome.Requeue -> Unit // fresh build + fresh link
            }
        }
        fail("too_many_attempts")
    }

    private enum class CycleOutcome { Done, Requeue }

    private suspend fun runCycle(): CycleOutcome {
        publish(UpdateFlow(UpdatePhase.Building))
        var dto = when (val r = transport.start()) {
            is ApiResult.Ok -> r.value
            is ApiResult.Err -> {
                fail(r.code); return CycleOutcome.Done
            }
        }
        var attempt = 0
        while (dto.state == "queued" || dto.state == "building") {
            if (attempt >= delays.pollAttempts) {
                fail("timeout"); return CycleOutcome.Done
            }
            delays.poll(attempt++)
            dto = when (val r = transport.status()) {
                is ApiResult.Ok -> r.value
                is ApiResult.Err -> {
                    fail(r.code); return CycleOutcome.Done
                }
            }
        }
        when (dto.state) {
            "failed" -> {
                fail(dto.error ?: "build_failed"); return CycleOutcome.Done
            }
            "ready" -> Unit
            else -> { // idle/consumed: the row vanished under us — requeue once
                return CycleOutcome.Requeue
            }
        }
        val url = dto.downloadUrl ?: run {
            fail("no_link"); return CycleOutcome.Done
        }
        return downloadAndVerify(dto, url)
    }

    private suspend fun downloadAndVerify(dto: AppUpdateDto, url: String): CycleOutcome {
        var net = 0
        while (true) {
            val r = transport.download(url, apkFile) { f -> publish(UpdateFlow(UpdatePhase.Downloading, f)) }
            when {
                r is ApiResult.Ok -> {
                    val want = dto.sha256
                    val got = transport.sha256(apkFile)
                    if (want == null || (got != null && got.equals(want, ignoreCase = true))) {
                        readyToInstall = true
                        autoLaunch = true
                        launch()
                        return CycleOutcome.Done
                    }
                    // Corrupted download also burned the single-use link → new cycle.
                    apkFile.delete()
                    return CycleOutcome.Requeue
                }
                r is ApiResult.Err && r.code == "expired" -> {
                    apkFile.delete()
                    return CycleOutcome.Requeue // link claimed elsewhere (e.g. crash) → fresh build
                }
                r is ApiResult.Err && r.code == "network" && net < delays.netRetries - 1 -> {
                    delays.retry(net++)
                }
                r is ApiResult.Err -> {
                    fail(if (r.code == "network") "download" else r.code); return CycleOutcome.Done
                }
            }
        }
    }

    private suspend fun handleInstall(outcome: InstallOutcome) {
        installInFlight = false
        when (outcome) {
            InstallOutcome.Success -> {
                readyToInstall = false
                autoLaunch = false
                onSuccess()
            }
            // System dialog dismissed: keep everything, no error UX — but stop
            // nudging. Only an explicit Install tap reopens the prompt.
            InstallOutcome.Aborted -> {
                autoLaunch = false
                publish(UpdateFlow(UpdatePhase.ReadyToInstall))
            }
            InstallOutcome.Conflict -> {
                readyToInstall = false
                autoLaunch = false
                apkFile.delete()
                fail("conflict")
            }
            InstallOutcome.Failure -> {
                readyToInstall = false
                autoLaunch = false
                apkFile.delete()
                fail("install_failed")
            }
        }
    }

    private fun fail(code: String) = publish(UpdateFlow(UpdatePhase.Failed, error = code))
}

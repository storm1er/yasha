package com.yasha.assist

import com.yasha.assist.core.net.ApkHashing
import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.AppUpdateDto
import com.yasha.assist.core.net.AppVersionDto
import com.yasha.assist.core.net.UpdateMeta
import com.yasha.assist.core.net.YashaChatApi
import java.io.File
import kotlinx.coroutines.delay

// Background auto-update pipeline (issue #34 Phase C): build → poll → download
// → verify, stopping at the verified APK on disk (the INSTALL tap stays in the
// foreground app). Everything effectful goes through the narrow AutoUpdateApi
// with injectable time, so the whole decision tree is JVM-testable; the
// CoroutineWorker is thin glue around runAutoUpdate().

enum class AutoUpdateOutcome {
    /** The admin disabled updates — notifications must come down. */
    Disabled,

    /** Server stamp ≤ installed: drop any stale artifact + reminder. */
    UpToDate,

    /** Verified APK on disk + meta written — remind the user to install. */
    Ready,

    /** Server still building when the time budget ran out — retry later. */
    Building,

    /** Any failure: silent (the periodic check tries again). */
    Failed,
}

/** The four endpoints of the pipeline (fake-driven in tests). */
interface AutoUpdateApi {
    suspend fun fetchAppVersion(): ApiResult<AppVersionDto>
    suspend fun startAppUpdate(): ApiResult<AppUpdateDto>
    suspend fun fetchAppUpdate(): ApiResult<AppUpdateDto>
    suspend fun downloadApk(path: String, dest: File, onFraction: (Float) -> Unit): ApiResult<Unit>
}

private class ClientAutoUpdateApi(private val client: YashaChatApi) : AutoUpdateApi {
    override suspend fun fetchAppVersion() = client.fetchAppVersion()
    override suspend fun startAppUpdate() = client.startAppUpdate()
    override suspend fun fetchAppUpdate() = client.fetchAppUpdate()
    override suspend fun downloadApk(path: String, dest: File, onFraction: (Float) -> Unit) =
        client.downloadApk(path, dest, onFraction)
}

fun autoUpdateApi(client: YashaChatApi): AutoUpdateApi = ClientAutoUpdateApi(client)

/** A previously auto-downloaded APK that still matches its marker, else null. */
fun pendingVerifiedApk(cacheDir: File): UpdateMeta? {
    val meta = UpdateMeta.read(cacheDir) ?: return null
    if (meta.sha256.isEmpty()) return null
    val got = ApkHashing.sha256(UpdateMeta.apkFile(cacheDir)) ?: return null
    return if (got.equals(meta.sha256, ignoreCase = true)) meta else null
}

/**
 * Drive one auto-update attempt for [version] (already fetched by the caller).
 * Budget-bounded so a slow server build never outlives the worker's runtime;
 * the state lives server-side, so the next attempt simply joins the build.
 */
suspend fun runAutoUpdate(
    api: AutoUpdateApi,
    version: AppVersionDto,
    cacheDir: File,
    budgetMs: Long = 8L * 60_000,
    now: () -> Long = System::currentTimeMillis,
    sleep: suspend (Long) -> Unit = ::delay,
): AutoUpdateOutcome {
    // A verified artifact for THIS version is already waiting → nothing to do.
    if (pendingVerifiedApk(cacheDir)?.versionCode == version.versionCode) return AutoUpdateOutcome.Ready

    var dto = when (val r = api.startAppUpdate()) {
        is ApiResult.Ok -> r.value
        is ApiResult.Err -> return AutoUpdateOutcome.Failed
    }
    val deadline = now() + budgetMs
    while (dto.state == "queued" || dto.state == "building") {
        if (now() >= deadline) return AutoUpdateOutcome.Building
        sleep(POLL_MS)
        dto = when (val r = api.fetchAppUpdate()) {
            is ApiResult.Ok -> r.value
            is ApiResult.Err -> return AutoUpdateOutcome.Failed
        }
    }
    if (dto.state != "ready") return AutoUpdateOutcome.Failed
    val url = dto.downloadUrl ?: return AutoUpdateOutcome.Failed

    val apk = UpdateMeta.apkFile(cacheDir)
    when (api.downloadApk(url, apk) {}) {
        is ApiResult.Ok -> Unit
        is ApiResult.Err -> {
            apk.delete()
            return AutoUpdateOutcome.Failed
        }
    }
    val got = ApkHashing.sha256(apk)
    val want = dto.sha256
    if (want != null && (got == null || !got.equals(want, ignoreCase = true))) {
        apk.delete()
        UpdateMeta.clear(cacheDir)
        return AutoUpdateOutcome.Failed
    }
    UpdateMeta.write(cacheDir, UpdateMeta(version.versionCode, version.versionName, want ?: got ?: ""))
    return AutoUpdateOutcome.Ready
}

private const val POLL_MS = 15_000L

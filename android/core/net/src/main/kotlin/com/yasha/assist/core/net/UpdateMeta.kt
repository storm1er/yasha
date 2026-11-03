package com.yasha.assist.core.net

import java.io.File

// On-disk handoff (issue #34, Phase C): when the background auto-download has
// fetched and checksum-verified an update, a meta file next to the APK records
// what that file IS. A later app start (notification tap) can then offer the
// verified APK straight to the installer without re-downloading.

data class UpdateMeta(val versionCode: Int, val versionName: String, val sha256: String) {
    companion object {
        /** Cache-dir-relative names shared by the updater and the worker. */
        const val APK_NAME = "update.apk"
        const val META_NAME = "yasha-update.meta"

        fun apkFile(cacheDir: File): File = File(cacheDir, APK_NAME)
        fun metaFile(cacheDir: File): File = File(cacheDir, META_NAME)

        fun write(cacheDir: File, meta: UpdateMeta) {
            metaFile(cacheDir).writeText("${meta.versionCode}\t${meta.versionName}\t${meta.sha256}")
        }

        /** Null when absent or malformed (e.g. written by an older/newer app). */
        fun read(cacheDir: File): UpdateMeta? {
            val parts = runCatching { metaFile(cacheDir).readText() }.getOrNull()
                ?.split('\t') ?: return null
            if (parts.size != 3) return null
            val code = parts[0].toIntOrNull() ?: return null
            if (parts[1].isEmpty() || parts[2].isEmpty()) return null
            return UpdateMeta(code, parts[1], parts[2])
        }

        /** Drops both the marker and the APK (installed / update gone). */
        fun clear(cacheDir: File) {
            metaFile(cacheDir).delete()
            apkFile(cacheDir).delete()
        }
    }
}

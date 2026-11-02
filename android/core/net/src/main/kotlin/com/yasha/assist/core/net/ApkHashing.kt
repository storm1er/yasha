package com.yasha.assist.core.net

import java.io.File
import java.security.MessageDigest

// APK checksum for the in-app updater (issue #34, Phase B): the server sends
// the SHA-256 of what it built; the download is only installed when the bytes
// on disk hash to the same value.
object ApkHashing {
    /** Lowercase hex SHA-256, or null when the file cannot be read. */
    fun sha256(file: File): String? = try {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        digest.digest().joinToString("") { b -> "%02x".format(b) }
    } catch (_: Exception) {
        null
    }
}

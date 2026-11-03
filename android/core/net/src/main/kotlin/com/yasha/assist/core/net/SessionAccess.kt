package com.yasha.assist.core.net

// Read/write surface of the stored session (SessionStore), extracted so the
// chat view-model can be driven by a fake in JVM unit tests — the destructive
// clear-vs-keep decision (issue #14) must be testable without a device.
interface SessionAccess {
    var baseUrl: String
    var token: String?
    var email: String?

    // Highest update versionCode the user dismissed (issue #34): re-prompts stay
    // silenced until a strictly newer code appears. Survives sign-out (device-
    // level annoyance control, not account data).
    var dismissedUpdateCode: Int

    // Issue #34 Phase C: build + download + verify updates in the background
    // while on Wi-Fi, then remind the user to install (one tap in the app).
    var autoDownloadWifi: Boolean

    fun signedIn(): Boolean

    fun clearSession()
}

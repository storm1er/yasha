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

    fun signedIn(): Boolean

    fun clearSession()
}

package com.yasha.assist

import android.app.Application
import com.yasha.assist.core.net.AppLocale
import com.yasha.assist.core.net.SessionStore
import com.yasha.assist.core.net.YashaClient

class YashaApp : Application() {
    lateinit var sessionStore: SessionStore
        private set
    lateinit var client: YashaClient
        private set

    override fun onCreate() {
        super.onCreate()
        sessionStore = SessionStore(this)
        AppLocale.tag = AppLocale.resolve(sessionStore.locale)
        // Pre-authenticated install: the web app bakes server + session into
        // this build (empty in the generic debug build → no-op).
        sessionStore.seed(
            BuildConfig.YASHA_SERVER_URL,
            BuildConfig.YASHA_SESSION_TOKEN,
            BuildConfig.YASHA_USERNAME,
        )
        client = YashaClient(sessionStore)
    }
}

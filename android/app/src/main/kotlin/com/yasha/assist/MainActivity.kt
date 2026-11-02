package com.yasha.assist

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.viewmodel.compose.viewModel
import com.yasha.assist.core.design.YashaTheme
import com.yasha.assist.core.net.AppLocale
import com.yasha.assist.feature.chat.ChatViewModel
import com.yasha.assist.feature.chat.SettingsViewModel
import com.yasha.assist.feature.chat.ThemePrefs
import com.yasha.assist.feature.chat.YashaAppRoot

class MainActivity : ComponentActivity() {
    private val assistTick = mutableLongStateOf(0L)
    private val assistPending = mutableStateOf<Pair<String, List<String>>?>(null)
    private val openThreadTick = mutableLongStateOf(0L)
    private val openThreadId = mutableStateOf<String?>(null)

    // Account-language override: resources resolve in AppLocale.tag, never
    // the device locale.
    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(AppLocale.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Gemini-like chrome: content draws edge-to-edge, bar icons follow the theme.
        val dark = ThemePrefs.darkOverride()
            ?: (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
                android.content.res.Configuration.UI_MODE_NIGHT_YES)
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        consumeAssistExtra(intent)
        val app = application as YashaApp
        setContent {
            YashaTheme(darkOverride = ThemePrefs.darkOverride()) {
                val vm: ChatViewModel = viewModel(
                    factory = ChatViewModel.Factory(
                        app.sessionStore,
                        app.client,
                        installedVersionCode = BuildConfig.VERSION_CODE,
                        installedVersionName = BuildConfig.VERSION_NAME,
                    ),
                )
                val svm: SettingsViewModel = viewModel(
                    factory = SettingsViewModel.Factory(
                        app.client,
                        { accountTag -> applyAccountLocale(app, accountTag) },
                        themeSource = { ThemePrefs.mode },
                        themeSink = { ThemePrefs.set(app, it) },
                    ),
                )
                YashaAppRoot(
                    vm,
                    svm,
                    assistTick = assistTick.longValue,
                    pendingProvider = { assistPending.value },
                    onPendingApplied = { assistPending.value = null },
                    threadTick = openThreadTick.longValue,
                    threadProvider = { openThreadId.value },
                    onThreadApplied = { openThreadId.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumeAssistExtra(intent)
    }

    // Account-locale application: persist the mirror, apply the override and
    // recreate — but only when the effective language actually changes (the
    // me-fetch on every settings open must not loop recreates).
    private fun applyAccountLocale(app: YashaApp, accountTag: String?) {
        if (app.sessionStore.locale != accountTag) app.sessionStore.locale = accountTag
        val next = AppLocale.resolve(accountTag)
        if (next != AppLocale.tag) {
            AppLocale.tag = next
            recreate()
        }
    }

    override fun onResume() {
        super.onResume()
        val roleHeld = getSystemService(android.app.role.RoleManager::class.java)
            ?.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT) == true
        AssistNotifier.maybeShowFallback(this, roleHeld)
    }

    private fun consumeAssistExtra(intent: Intent?) {
        intent?.getStringExtra(EXTRA_THREAD)?.let {
            intent.removeExtra(EXTRA_THREAD)
            openThreadId.value = it
            openThreadTick.longValue = System.currentTimeMillis()
        }
        if (intent?.hasExtra(EXTRA_ASSIST) == true) {
            intent.removeExtra(EXTRA_ASSIST)
            assistPending.value = com.yasha.assist.feature.assist.PendingAskStore.consume()?.let { it.text to it.attachments }
            assistTick.longValue = System.currentTimeMillis()
        }
    }

    companion object {
        const val EXTRA_ASSIST = "com.yasha.assist.extra.ASSIST"
        const val EXTRA_THREAD = "com.yasha.assist.extra.THREAD"
    }
}

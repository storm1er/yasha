package com.yasha.assist.feature.chat

import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

object RoleGate {
    // A15: opens the permission-controller role picker (default-assistant list).
    const val ACTION_MANAGE_DEFAULT_APP = "android.intent.action.MANAGE_DEFAULT_APP"
    const val EXTRA_ROLE_NAME = "android.intent.extra.ROLE_NAME"

    fun available(context: Context): Boolean =
        context.getSystemService(RoleManager::class.java)?.isRoleAvailable(RoleManager.ROLE_ASSISTANT) == true

    fun held(context: Context): Boolean =
        context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true
}

// Assistant-role status + onboarding for this phone (settings "phone" section),
// with the no-role fallbacks documented below.
@Composable
fun PhoneSettingsBody() {
    val context = androidx.compose.ui.platform.LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { tick++ }
    val available = remember(tick) { RoleGate.available(context) }
    val held = remember(tick) { RoleGate.held(context) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            stringResource(if (held) R.string.setup_held else if (available) R.string.setup_not_held else R.string.setup_unavailable),
            style = MaterialTheme.typography.titleMedium,
            color = if (held) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
        Button(
            onClick = {
                // Android 14+ marks ROLE_ASSISTANT requestable=false in roles.xml:
                // createRequestRoleIntent is refused for EVERY app (HA included).
                // The supported path is the permission-controller default-app picker.
                val picker = Intent(RoleGate.ACTION_MANAGE_DEFAULT_APP)
                    .putExtra(RoleGate.EXTRA_ROLE_NAME, RoleManager.ROLE_ASSISTANT)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                val fallback = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    launcher.launch(picker)
                } catch (_: ActivityNotFoundException) {
                    launcher.launch(fallback)
                }
            },
            enabled = available && !held,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.setup_request)) }
        Text(stringResource(R.string.setup_note_default), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.setup_note_reinstall), style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.setup_fallbacks_title), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.setup_fallbacks), style = MaterialTheme.typography.bodyMedium)
    }
}

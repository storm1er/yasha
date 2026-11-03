package com.yasha.assist.feature.chat

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardOptions
import com.yasha.assist.core.design.LocalYashaPalette
import com.yasha.assist.core.net.AppLocale
import com.yasha.assist.core.net.McpToolDto

@Composable
fun SettingsScreen(vm: SettingsViewModel, cvm: ChatViewModel, onBack: () -> Unit) {
    val state by vm.state.collectAsState()
    val palette = LocalYashaPalette.current
    val snackbar = remember { SnackbarHostState() }
    var tab by remember { mutableStateOf("general") }
    val savedMsg = stringResource(R.string.saved)
    val doneMsg = stringResource(R.string.action_done)
    val mutationsMsg = stringResource(R.string.mutations_off)
    val limitMsg = stringResource(R.string.key_limit_error)
    val errorMsg = stringResource(R.string.settings_error)
    val usersErrUsernameMsg = stringResource(R.string.users_err_username_taken)
    val usersErrEmailMsg = stringResource(R.string.users_err_email_taken)
    val userMcpQuotaMsg = stringResource(R.string.user_mcp_quota)
    val userMcpDisabledMsg = stringResource(R.string.user_mcp_disabled_notice)
    val mcpPrivateUrlMsg = stringResource(R.string.mcp_private_url_error)
    val mcpBadUrlMsg = stringResource(R.string.mcp_bad_url_error)
    val mcpBadHeadersMsg = stringResource(R.string.mcp_bad_headers_error)
    val mcpBadNameMsg = stringResource(R.string.mcp_bad_name_error)
    BackHandler(onBack = onBack)
    LaunchedEffect(Unit) { vm.open() }
    // OAuth consent for a user MCP server: open the authorization URL in the
    // browser once; the VM polls until the server becomes authorized.
    val appContext = LocalContext.current
    LaunchedEffect(state.userMcpAuthUrl) {
        val url = state.userMcpAuthUrl ?: return@LaunchedEffect
        runCatching {
            appContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
        vm.userMcpAuthUrlHandled()
    }
    LaunchedEffect(state.noticeTick) {
        if (state.noticeTick > 0) {            val msg = when (state.notice) {
                "saved" -> savedMsg
                "done" -> doneMsg
                "mutations" -> mutationsMsg
                "limit" -> limitMsg
                "username_taken" -> usersErrUsernameMsg
                "email_taken" -> usersErrEmailMsg
                "quota_exceeded" -> userMcpQuotaMsg
                "user_servers_disabled" -> userMcpDisabledMsg
                "private_url_blocked" -> mcpPrivateUrlMsg
                "invalid_url" -> mcpBadUrlMsg
                "invalid_headers" -> mcpBadHeadersMsg
                "invalid_name" -> mcpBadNameMsg
                else -> errorMsg
            }
            snackbar.showSnackbar(msg)
        }
    }
    CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) {
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back), tint = MaterialTheme.colorScheme.onSurface)
            }
            Spacer(Modifier.width(6.dp))
            SparkleLogo(18.dp)
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleMedium)
        }
        val tabs = buildList {
            add("general" to R.string.tab_general)
            add("security" to R.string.tab_security)
            add("memory" to R.string.tab_memory)
            if (state.isAdmin) {
                add("backend" to R.string.tab_backend)
                add("jobs" to R.string.tab_jobs)
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            tabs.forEach { (id, label) ->
                val active = tab == id
                Box(
                    Modifier.clip(CircleShape)
                        .background(if (active) MaterialTheme.colorScheme.surface else Color.Transparent)
                        .border(1.dp, if (active) palette.composerOutline else Color.Transparent, CircleShape)
                        .clickable { tab = id; vm.onTab(id) }
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                ) {
                    Text(stringResource(label), fontSize = 13.sp, color = if (active) MaterialTheme.colorScheme.onSurface else palette.iconGray)
                }
            }
        }
        Box(Modifier.weight(1f)) {
            val scroll = rememberScrollState()
            Column(
                Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                when (tab) {
                    "general" -> GeneralTab(vm, state, cvm)
                    "security" -> SecurityTab(vm, state)
                    "memory" -> MemoryTab(vm, state)
                    "backend" -> if (state.isAdmin) LemonadeTab(vm, state)
                    "jobs" -> if (state.isAdmin) JobsTab(vm, state)
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        SnackbarHost(snackbar, Modifier.padding(bottom = 18.dp))
    }
    }
}

// ── shared widgets ───────────────────────────────────────────────────────────

@Composable
fun SectionCard(
    title: String,
    intro: String? = null,
    action: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, LocalYashaPalette.current.composerOutline, RoundedCornerShape(16.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            action?.invoke()
        }
        if (intro != null) Text(intro, style = MaterialTheme.typography.bodySmall, color = LocalYashaPalette.current.iconGray)
        content()
    }
}

@Composable
fun AdminZoneHeader() {
    val palette = LocalYashaPalette.current
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Default.Lock, null, modifier = Modifier.size(14.dp), tint = palette.iconGray)
        Text(
            stringResource(R.string.admin_zone_title).uppercase(),
            fontSize = 11.sp,
            letterSpacing = 1.sp,
            color = palette.iconGray,
        )
        Box(Modifier.weight(1f).height(1.dp).background(palette.composerOutline))
    }
}

@Composable
fun NumField(label: String, value: String, type: KeyboardType = KeyboardType.Number, onChange: (String) -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = type),
            modifier = Modifier.width(150.dp),
            textStyle = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
fun TextFieldRow(label: String, value: String, hint: String = "", onChange: (String) -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        OutlinedTextField(value = value, onValueChange = onChange, singleLine = true, modifier = Modifier.fillMaxWidth(), textStyle = MaterialTheme.typography.bodyMedium)
        if (hint.isNotEmpty()) Text(hint, style = MaterialTheme.typography.bodySmall, color = LocalYashaPalette.current.iconGray)
    }
}

@Composable
fun DropdownField(
    label: String,
    value: String,
    options: List<String>,
    placeholder: String,
    emptyLabel: String?,
    display: ((String) -> String)? = null,
    onChange: (String) -> Unit,
) {
    val palette = LocalYashaPalette.current
    var menu by remember { mutableStateOf(false) }
    val current = (if (value.isNotEmpty() && value !in options) listOf(value) else options)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Box {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .border(1.dp, palette.composerOutline, RoundedCornerShape(12.dp))
                    .clickable { menu = true }.padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    (display?.invoke(value) ?: value).ifEmpty { placeholder },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (value.isEmpty()) palette.iconGray else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(Icons.Default.ArrowDropDown, null, tint = palette.iconGray)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (emptyLabel != null) {
                    DropdownMenuItem(text = { Text(emptyLabel) }, onClick = { onChange(""); menu = false })
                }
                current.forEach { id ->
                    DropdownMenuItem(
                        text = { Text(display?.invoke(id) ?: id, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        trailingIcon = { if (id == value) Icon(Icons.Default.Check, null, Modifier.size(18.dp)) },
                        onClick = { onChange(id); menu = false },
                    )
                }
            }
        }
    }
}

@Composable
fun PillButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier.clip(CircleShape)
            .background(if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 10.dp),
    ) {
        Text(label, color = if (enabled) MaterialTheme.colorScheme.onPrimary else LocalYashaPalette.current.iconGray, fontSize = 14.sp)
    }
}

@Composable
fun SwitchRow(title: String, subtitle: String? = null, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = LocalYashaPalette.current.iconGray)
        }
        Switch(checked = checked, onCheckedChange = onChecked)
    }
}

@StringRes
internal fun memoryKindLabel(kind: String) = when (kind) {
    "preference" -> R.string.kind_preference
    "insight" -> R.string.kind_insight
    else -> R.string.kind_fact
}

@StringRes
internal fun memoryConfidenceLabel(confidence: String) = when (confidence) {
    "medium" -> R.string.confidence_medium
    "high" -> R.string.confidence_high
    else -> R.string.confidence_low
}

@Composable
fun SmallBadge(text: String, filled: Boolean) {
    val palette = LocalYashaPalette.current
    Box(
        Modifier.clip(RoundedCornerShape(8.dp))
            .background(if (filled) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .border(1.dp, palette.composerOutline, RoundedCornerShape(8.dp))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(text, fontSize = 10.sp, color = palette.iconGray)
    }
}

@Composable
fun ConfirmDialog(title: String, body: String, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirmLabel, color = MaterialTheme.colorScheme.primary) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

// ── General tab ──────────────────────────────────────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GeneralTab(vm: SettingsViewModel, state: SettingsUiState, cvm: ChatViewModel) {
    // Account language: drives this app AND server-generated content. Never
    // the device locale (account wins; null ⇒ default en).
    SectionCard(stringResource(R.string.language_title), stringResource(R.string.language_intro)) {
        val current = AppLocale.resolve(state.accountLocale)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf("en" to stringResource(R.string.lang_en), "fr" to stringResource(R.string.lang_fr)).forEach { (tag, label) ->
                if (tag == current) PillButton(label) { }
                else OutlinedButton(onClick = { vm.setAccountLocale(tag) }) { Text(label) }
            }
        }
    }
    // Appearance (issue #15 parity with the web theme toggle): per-device.
    SectionCard(stringResource(R.string.appearance_title), stringResource(R.string.appearance_intro)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf(
                ThemePrefs.SYSTEM to stringResource(R.string.theme_system),
                ThemePrefs.LIGHT to stringResource(R.string.theme_light),
                ThemePrefs.DARK to stringResource(R.string.theme_dark),
            ).forEach { (id, label) ->
                if (state.themeMode == id) PillButton(label) { }
                else OutlinedButton(onClick = { vm.setThemeMode(id) }) { Text(label) }
            }
        }
    }
    // Admin kill-switch off ⇒ the whole preference is meaningless: hide the card.
    if (state.mcpInstanceEnabled != false) {
        SectionCard(stringResource(R.string.tools_title), stringResource(R.string.tools_intro)) {
            SwitchRow(
                stringResource(R.string.tools_follow),
                checked = state.mcpUserEnabled,
                onChecked = { vm.setMcpPref(it) },
            )
        }
    }
    // Own MCP servers (mirrors the web user-mcp-card). Hidden while the admin
    // guardrail (mcp.userServersEnabled) is off.
    if (state.userMcpLoaded && state.userMcpEnabled) {
        val palette = LocalYashaPalette.current
        SectionCard(
            stringResource(R.string.user_mcp_title),
            stringResource(R.string.user_mcp_intro),
            action = {
                Text(
                    stringResource(R.string.user_mcp_count, state.userMcpServers.size, state.userMcpMax),
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.iconGray,
                )
            },
        ) {
            if (state.userMcpServers.isEmpty()) {
                Text(stringResource(R.string.user_mcp_none), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
            }
            state.userMcpServers.forEach { srv ->
                var showTools by remember(srv) { mutableStateOf(false) }
                var showHeaders by remember(srv) { mutableStateOf(false) }
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(srv.name, style = MaterialTheme.typography.bodyLarge)
                    srv.url?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.iconGray) }
                    srv.headers?.keys?.sorted()?.let { keys ->
                        Text(keys.joinToString(" · ") { "$it: ••••" }, fontSize = 11.sp, color = palette.iconGray)
                    }
                    Text(
                        when {
                            srv.health.ok -> stringResource(R.string.user_mcp_healthy, srv.health.toolCount)
                            srv.health.code == "needs_auth" -> stringResource(R.string.user_mcp_needs_auth)
                            else -> stringResource(R.string.user_mcp_unhealthy, srv.health.error ?: "error")
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (srv.health.ok) Color(0xFF1E8E3E) else MaterialTheme.colorScheme.error,
                    )
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        // Mirrors the web card: Connect offered whenever not
                        // authorized (starts OAuth); Disconnect once authorized.
                        if (srv.oauth.authorized) {
                            TextButton(onClick = { vm.userMcpAction("disconnect", id = srv.id) }) { Text(stringResource(R.string.user_mcp_disconnect), fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
                        } else if (srv.url != null) {
                            TextButton(onClick = { vm.userMcpConnect(srv.id) }) { Text(stringResource(R.string.user_mcp_connect), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                        }
                        TextButton(onClick = { vm.userMcpAction("check", id = srv.id) }) { Text(stringResource(R.string.admin_mcp_check), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                        TextButton(onClick = { vm.userMcpAction("toggle", id = srv.id) }) { Text(stringResource(if (srv.enabled) R.string.admin_mcp_disable else R.string.admin_mcp_enable), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                        TextButton(onClick = { vm.userMcpAction("delete", id = srv.id) }) { Text(stringResource(R.string.admin_mcp_delete), fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
                        TextButton(onClick = { showTools = !showTools }) { Text(stringResource(if (showTools) R.string.admin_mcp_hide_tools else R.string.admin_mcp_show_tools), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                        TextButton(onClick = { showHeaders = !showHeaders }) { Text(stringResource(R.string.mcp_headers), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                    }
                    if (showHeaders) {
                        McpHeadersForm(
                            existing = srv.headers?.keys?.sorted() ?: emptyList(),
                            onSave = { patch ->
                                if (patch.isEmpty()) { showHeaders = false; return@McpHeadersForm }
                                vm.userMcpAction("update", id = srv.id, headers = patch, onDone = { if (it) showHeaders = false })
                            },
                            onCancel = { showHeaders = false },
                        )
                    }
                    if (showTools) {
                        McpToolList(
                            tools = srv.tools,
                            disabledTools = srv.disabledTools,
                            onExclude = { tool -> vm.userMcpAction("update", id = srv.id, disabledTools = srv.disabledTools + tool) },
                            onInclude = { tool -> vm.userMcpAction("update", id = srv.id, disabledTools = srv.disabledTools.filter { it != tool }) },
                        )
                    }
                }
            }
            var adding by remember { mutableStateOf(false) }
            var newName by remember { mutableStateOf("") }
            var newUrl by remember { mutableStateOf("") }
            var newHeaders by remember { mutableStateOf(mapOf<String, String>()) }
            if (adding) {
                OutlinedTextField(newName, { newName = it }, singleLine = true, label = { Text(stringResource(R.string.admin_mcp_name)) }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(newUrl, { newUrl = it }, singleLine = true, label = { Text(stringResource(R.string.admin_mcp_url)) }, modifier = Modifier.fillMaxWidth())
                if (!state.userMcpPrivateUrlsAllowed) {
                    Text(stringResource(R.string.user_mcp_lan_hint), fontSize = 11.sp, color = palette.iconGray)
                }
                McpHeadersForm(existing = null, onChange = { newHeaders = it })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    PillButton(stringResource(R.string.admin_mcp_add), enabled = newName.isNotBlank() && newUrl.isNotBlank()) {
                        // Keep the input on failure (error surfaces as a notice).
                        vm.userMcpAction(
                            "add",
                            name = newName.trim(),
                            url = newUrl.trim(),
                            headers = newHeaders.ifEmpty { null },
                            onDone = { ok ->
                                if (ok) {
                                    newName = ""; newUrl = ""; newHeaders = emptyMap(); adding = false
                                }
                            },
                        )
                    }
                    TextButton(onClick = { adding = false; newName = ""; newUrl = ""; newHeaders = emptyMap() }) { Text(stringResource(R.string.cancel), color = MaterialTheme.colorScheme.primary) }
                }
            } else {
                PillButton(stringResource(R.string.admin_mcp_add_server), enabled = state.userMcpServers.size < state.userMcpMax) { adding = true }
            }
        }
    }
    SectionCard(stringResource(R.string.tab_phone), stringResource(R.string.phone_intro)) {
        PhoneSettingsBody()
    }

    // Update channel (issue #34, Phase A): installed stamp + manual check.
    // The check result reuses the chat view-model (auto-check runs on entry).
    SectionCard(stringResource(R.string.update_card_title), stringResource(R.string.update_card_intro)) {
        val chat by cvm.state.collectAsState()
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(R.string.update_installed_fmt, chat.installedVersionName, chat.installedVersionCode),
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = { cvm.checkForUpdates() }) {
                Text(stringResource(R.string.update_check_button))
            }
            chat.updateCheckResult?.let { r ->
                Text(
                    when {
                        r == "up_to_date" -> stringResource(R.string.update_up_to_date)
                        r.startsWith("error:") -> stringResource(ErrorStrings.messageRes(r.removePrefix("error:")))
                        else -> stringResource(R.string.update_found_fmt, r)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            // Issue #34 Phase C: fetch + verify over Wi-Fi in the background,
            // then remind the user — the install tap stays in-app.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = chat.autoDownloadWifi,
                    onCheckedChange = { cvm.setAutoDownloadWifi(it) },
                )
                Column {
                    Text(stringResource(R.string.update_auto_label), style = MaterialTheme.typography.bodyMedium)
                    Text(
                        stringResource(R.string.update_auto_sub),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

// ── Security tab ─────────────────────────────────────────────────────────────

// Expander body shared by the user + admin MCP cards (mirrors the web tool
// list: name + wrapped description per row, exclude/include buttons).
// Header editor for static MCP headers (mirrors the web McpHeadersEditor):
// rows of key/value with upsert / delete semantics. `existing` = the masked
// keys already stored (edit mode: empty value keeps, type to replace, remove
// deletes → merge-patch via onSave); null = add mode (onChange reports the
// full dict on every keystroke).
private data class McpHeaderRow(val key: String, val value: String, val existing: Boolean, val removed: Boolean = false)

@Composable
private fun McpHeadersForm(
    existing: List<String>?,
    onSave: ((Map<String, String?>) -> Unit)? = null,
    onChange: ((Map<String, String>) -> Unit)? = null,
    onCancel: (() -> Unit)? = null,
) {
    val palette = LocalYashaPalette.current
    val initialRows: List<McpHeaderRow> = existing?.map { McpHeaderRow(key = it, value = "", existing = true) } ?: emptyList()
    val rowsState = remember { mutableStateOf(initialRows) }
    val rows = rowsState.value
    fun setRows(next: List<McpHeaderRow>) {
        rowsState.value = next
        if (existing == null && onChange != null) {
            onChange(next.filter { it.key.isNotBlank() }.associate { it.key.trim() to it.value })
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.mcp_headers_hint), fontSize = 11.sp, color = palette.iconGray)
        rows.forEachIndexed { index, row ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (row.existing) {
                    Text(
                        row.key,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                        color = if (row.removed) palette.iconGray else Color.Unspecified,
                    )
                } else {
                    OutlinedTextField(
                        row.key,
                        { v -> setRows(rows.mapIndexed { i, r -> if (i == index) r.copy(key = v) else r }) },
                        singleLine = true,
                        label = { Text(stringResource(R.string.mcp_header_name)) },
                        modifier = Modifier.weight(1f),
                    )
                }
                OutlinedTextField(
                    row.value,
                    { v -> setRows(rows.mapIndexed { i, r -> if (i == index) r.copy(value = v) else r }) },
                    singleLine = true,
                    enabled = !row.removed,
                    visualTransformation = PasswordVisualTransformation(),
                    label = { Text(if (row.existing) "••••" else stringResource(R.string.mcp_header_value)) },
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        setRows(
                            if (row.existing) rows.mapIndexed { i, r -> if (i == index) r.copy(removed = !r.removed) else r }
                            else rows.filterIndexed { i, _ -> i != index },
                        )
                    },
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                ) {
                    Text(stringResource(R.string.mcp_header_remove), fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onSave != null) {
                PillButton(stringResource(R.string.mcp_headers_save)) {
                    onSave(
                        rows.mapNotNull { r ->
                            when {
                                r.removed -> Pair(r.key, null)
                                r.existing && r.value.isNotEmpty() -> Pair(r.key, r.value)
                                !r.existing && r.key.isNotBlank() -> Pair(r.key.trim(), r.value)
                                else -> null
                            }
                        }.toMap(),
                    )
                }
            }
            PillButton(stringResource(R.string.mcp_header_add)) { setRows(rows + McpHeaderRow(key = "", value = "", existing = false)) }
            if (onCancel != null) {
                TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel), color = MaterialTheme.colorScheme.primary) }
            }
        }
    }
}

@Composable
private fun McpToolList(
    tools: List<McpToolDto>,
    disabledTools: List<String>,
    onExclude: (String) -> Unit,
    onInclude: (String) -> Unit,
) {
    val palette = LocalYashaPalette.current
    if (tools.isEmpty() && disabledTools.isEmpty()) {
        Text(stringResource(R.string.admin_mcp_no_tools), fontSize = 12.sp, color = palette.iconGray)
    }
    tools.forEach { t ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.name, fontSize = 12.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
                if (t.description.isNotBlank()) {
                    Text(t.description, fontSize = 11.sp, color = palette.iconGray)
                }
            }
            TextButton(
                onClick = { onExclude(t.name) },
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
            ) {
                Text(stringResource(R.string.admin_mcp_exclude_tool), fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
    disabledTools.forEach { d ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    d,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = palette.iconGray,
                    textDecoration = TextDecoration.LineThrough,
                )
                Text(stringResource(R.string.admin_mcp_tool_excluded), fontSize = 11.sp, color = palette.iconGray)
            }
            TextButton(
                onClick = { onInclude(d) },
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
            ) {
                Text(stringResource(R.string.admin_mcp_include_tool), fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@Composable
private fun SecurityTab(vm: SettingsViewModel, state: SettingsUiState) {
    val palette = LocalYashaPalette.current
    var createOpen by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var editTarget by remember { mutableStateOf<UserRow?>(null) }
    var editUser by remember { mutableStateOf("") }
    var editEmail by remember { mutableStateOf("") }
    var editPass by remember { mutableStateOf("") }
    var revealed by remember { mutableStateOf<String?>(null) }
    var revokeTarget by remember { mutableStateOf<ApiKeyRow?>(null) }
    var limit by remember { mutableStateOf(state.apiTimeoutSec) }
    LaunchedEffect(state.apiTimeoutSec) { limit = state.apiTimeoutSec }

    SectionCard(stringResource(R.string.api_card_title), stringResource(R.string.api_card_intro)) {
        Text(
            stringResource(R.string.api_keys_intro, state.keysActive, state.keysMax),
            style = MaterialTheme.typography.bodySmall,
            color = palette.iconGray,
        )
        if (state.apiKeys.isEmpty()) {
            Text(stringResource(R.string.api_keys_empty), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        } else {
            state.apiKeys.forEach { k ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(k.name, style = MaterialTheme.typography.bodyLarge)
                            SmallBadge(stringResource(if (k.revoked) R.string.key_revoked else R.string.key_active), filled = k.revoked)
                        }
                        Text("${k.masked} · ${k.createdAt}", style = MaterialTheme.typography.bodySmall, color = palette.iconGray)
                    }
                    if (!k.revoked) {
                        TextButton(onClick = { revokeTarget = k }) {
                            Text(stringResource(R.string.key_revoke), color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                        }
                    }
                }
            }
        }
        PillButton(stringResource(R.string.key_create), enabled = state.keysActive < state.keysMax) { name = ""; createOpen = true }
    }

    if (state.isAdmin) {
        AdminZoneHeader()
        SectionCard(stringResource(R.string.api_limits_title), stringResource(R.string.api_limits_intro)) {
            NumField(stringResource(R.string.api_first_token), limit) { limit = it; vm.setApiField("timeout", it) }
            NumField(stringResource(R.string.api_tokens_default), state.apiMaxTokensDefault) { vm.setApiField("def", it) }
            NumField(stringResource(R.string.api_tokens_cap), state.apiMaxTokensCap) { vm.setApiField("cap", it) }
            PillButton(stringResource(R.string.save)) { vm.saveApiLimits() }
        }
        SectionCard(stringResource(R.string.registration_title), stringResource(R.string.registration_intro)) {
            SwitchRow(
                stringResource(R.string.registration_toggle),
                checked = state.registrationAllowed,
                onChecked = { vm.setRegistrationEnabled(it) },
            )
        }
    }

    val userRows = if (state.isAdmin) state.users else listOfNotNull(state.self)
    SectionCard(
        stringResource(if (state.isAdmin) R.string.users_title else R.string.me_title),
        stringResource(if (state.isAdmin) R.string.users_intro else R.string.me_intro),
    ) {
        if (userRows.isEmpty()) {
            Text(stringResource(R.string.users_empty), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        }
        userRows.forEach { u ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(u.username, style = MaterialTheme.typography.bodyLarge)
                        if (u.role == "admin") SmallBadge("admin", filled = true)
                    }
                    Text(u.email, style = MaterialTheme.typography.bodySmall, color = palette.iconGray)
                }
                TextButton(onClick = { editTarget = u; editUser = u.username; editEmail = u.email; editPass = "" }) {
                    Text(stringResource(R.string.users_edit), color = MaterialTheme.colorScheme.primary, fontSize = 13.sp)
                }
            }
        }
    }

    // Own active sessions (issue #15 parity with the web SessionsCard): revoke
    // other devices; the current one is marked and cannot be revoked.
    SectionCard(stringResource(R.string.sessions_title), stringResource(R.string.sessions_intro)) {
        if (state.sessions.isEmpty()) {
            Text(stringResource(R.string.sessions_empty), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        } else {
            state.sessions.forEach { s ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                s.userAgent.ifEmpty { stringResource(R.string.sessions_unknown_device) },
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (s.current) SmallBadge(stringResource(R.string.sessions_current), filled = true)
                        }
                        Text(
                            listOf(
                                s.ipAddress.takeIf { it.isNotEmpty() },
                                s.lastUsedAt.take(16).replace('T', ' '),
                            ).filterNotNull().joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.iconGray,
                        )
                    }
                    if (!s.current) {
                        TextButton(onClick = { vm.revokeSession(s.id) }) {
                            Text(stringResource(R.string.sessions_revoke), color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                        }
                    }
                }
            }
        }
        if (state.sessions.count { !it.current } > 0) {
            PillButton(stringResource(R.string.sessions_revoke_others)) { vm.revokeOtherSessions() }
        }
    }

    editTarget?.let { u ->
        AlertDialog(
            onDismissRequest = { editTarget = null },
            title = { Text(stringResource(R.string.users_edit_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(editUser, { editUser = it }, singleLine = true, label = { Text(stringResource(R.string.users_username)) })
                    OutlinedTextField(editEmail, { editEmail = it }, singleLine = true, label = { Text(stringResource(R.string.users_email)) })
                    OutlinedTextField(editPass, { editPass = it }, singleLine = true, label = { Text(stringResource(R.string.users_password)) })
                    Text(stringResource(R.string.users_password_hint), style = MaterialTheme.typography.bodySmall, color = palette.iconGray)
                }
            },
            confirmButton = {
                TextButton(enabled = !state.busy, onClick = {
                    val un = editUser.trim().takeIf { it.isNotEmpty() && it != u.username }
                    val em = editEmail.trim().takeIf { it.isNotEmpty() && !it.equals(u.email, ignoreCase = true) }
                    val pw = editPass.takeIf { it.isNotEmpty() }
                    if (un != null || em != null || pw != null) vm.saveUser(u.id, un, em, pw)
                    editTarget = null
                }) { Text(stringResource(R.string.save), color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = { TextButton(onClick = { editTarget = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }

    if (createOpen) {
        AlertDialog(
            onDismissRequest = { createOpen = false },
            title = { Text(stringResource(R.string.key_create_title)) },
            text = {
                OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, label = { Text(stringResource(R.string.key_name_hint)) })
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank() && !state.busy, onClick = { vm.createApiKey(name) { revealed = it }; createOpen = false }) {
                    Text(stringResource(R.string.key_create_confirm), color = MaterialTheme.colorScheme.primary)
                }
            },
            dismissButton = { TextButton(onClick = { createOpen = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    revealed?.let { key ->
        AlertDialog(
            onDismissRequest = { revealed = null },
            title = { Text(stringResource(R.string.key_revealed_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.key_revealed_warning), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Text(key, style = MaterialTheme.typography.bodySmall)
                    val context = LocalContext.current
                    val copiedMsg = stringResource(R.string.copied)
                    PillButton(stringResource(R.string.copy_action)) { copyText(context, key, "api-key", copiedMsg) }
                }
            },
            confirmButton = { TextButton(onClick = { revealed = null }) { Text(stringResource(R.string.done)) } },
        )
    }
    revokeTarget?.let { k ->
        ConfirmDialog(
            stringResource(R.string.key_revoke_title),
            stringResource(R.string.key_revoke_body),
            stringResource(R.string.key_revoke),
            onConfirm = { vm.revokeApiKey(k.id); revokeTarget = null },
            onDismiss = { revokeTarget = null },
        )
    }
}

// ── task editor (schedule/model/timeout/attempts) ────────────────────────────

@Composable
fun TaskEditor(
    cfg: TaskConfig,
    models: List<String>,
    afterEachLabel: String,
    neverWarning: String,
    display: ((String) -> String)? = null,
    onChange: ((TaskConfig) -> TaskConfig) -> Unit,
    onSave: () -> Unit,
) {
    val palette = LocalYashaPalette.current
    val schedules = listOf(
        "after_persist" to afterEachLabel,
        "idle" to stringResource(R.string.schedule_idle),
        "cron" to stringResource(R.string.schedule_cron),
        "never" to stringResource(R.string.schedule_never),
    )
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.schedule), style = MaterialTheme.typography.labelLarge)
        schedules.forEach { (id, label) ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onChange { it.copy(schedule = id) } }.padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = cfg.schedule == id, onCheckedChange = { onChange { it.copy(schedule = id) } })
                Text(label, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (cfg.schedule == "never") Text(neverWarning, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        if (cfg.schedule == "idle") {
            NumField(stringResource(R.string.idle_minutes), cfg.idleMinutes) { v -> onChange { it.copy(idleMinutes = v) } }
        }
        if (cfg.schedule == "cron") {
            TextFieldRow(stringResource(R.string.cron_expr), cfg.cronExpr) { v -> onChange { it.copy(cronExpr = v) } }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.task_model), style = MaterialTheme.typography.labelLarge)
            var modelMenu by remember { mutableStateOf(false) }
            Box {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                        .border(1.dp, palette.composerOutline, RoundedCornerShape(12.dp))
                        .clickable { modelMenu = true }.padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        cfg.model.let { display?.invoke(it) ?: it }.ifEmpty { stringResource(R.string.task_model_hint) },
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (cfg.model.isEmpty()) palette.iconGray else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.model_auto)) }, onClick = { onChange { it.copy(model = "") }; modelMenu = false })
                    models.forEach { m ->
                        DropdownMenuItem(
                            text = { Text(display?.invoke(m) ?: m, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            onClick = { onChange { it.copy(model = m) }; modelMenu = false },
                        )
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.timeout_s), cfg.timeoutSec) { v -> onChange { it.copy(timeoutSec = v) } } }
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.attempts), cfg.maxAttempts) { v -> onChange { it.copy(maxAttempts = v) } } }
        }
        SwitchRow(stringResource(R.string.enabled), checked = cfg.enabled, onChecked = { c -> onChange { it.copy(enabled = c) } })
        PillButton(stringResource(R.string.save)) { onSave() }
    }
}

// ── Memory tab ───────────────────────────────────────────────────────────────

@Composable
private fun MemoryTab(vm: SettingsViewModel, state: SettingsUiState) {
    val palette = LocalYashaPalette.current
    var draft by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("fact") }
    var editing by remember { mutableStateOf<Pair<String, String>?>(null) }

    SectionCard(stringResource(R.string.memory_title), stringResource(R.string.memory_intro)) {
        if (state.memoryInstanceEnabled == false) {
            Text(stringResource(R.string.memory_instance_disabled), style = MaterialTheme.typography.bodySmall, color = Color(0xFFB26A00))
        }
        SwitchRow(stringResource(R.string.memory_optout), checked = state.memoryUserEnabled, onChecked = { vm.setMemoryOptOut(it) })
        OutlinedTextField(
            value = draft,
            onValueChange = { if (it.length <= 500) draft = it },
            placeholder = { Text(stringResource(R.string.memory_add_hint), color = palette.iconGray) },
            modifier = Modifier.fillMaxWidth(),
            textStyle = MaterialTheme.typography.bodyMedium,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            var kindMenu by remember { mutableStateOf(false) }
            Box {
                Row(
                    Modifier.clip(CircleShape).border(1.dp, palette.composerOutline, CircleShape)
                        .clickable { kindMenu = true }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(if (kind == "fact") stringResource(R.string.kind_fact) else stringResource(R.string.kind_preference), fontSize = 12.sp)
                }
                DropdownMenu(expanded = kindMenu, onDismissRequest = { kindMenu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.kind_fact)) }, onClick = { kind = "fact"; kindMenu = false })
                    DropdownMenuItem(text = { Text(stringResource(R.string.kind_preference)) }, onClick = { kind = "preference"; kindMenu = false })
                }
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { vm.addMemory(draft, kind); draft = "" }, enabled = draft.isNotBlank()) {
                Icon(Icons.Default.Add, stringResource(R.string.memory_add), tint = MaterialTheme.colorScheme.primary)
            }
        }
        state.memoryProfile?.let { p ->
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row {
                    Text(stringResource(R.string.memory_profile_title), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                    state.memoryProfileVersion?.let { Text("#$it", fontSize = 10.sp, color = palette.iconGray) }
                }
                Text(p, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (state.memories.isEmpty()) {
            Text(stringResource(R.string.memory_empty), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        } else {
            state.memories.forEach { m ->
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (editing?.first == m.id) {
                        OutlinedTextField(
                            value = editing!!.second,
                            onValueChange = { if (it.length <= 500) editing = m.id to it },
                            modifier = Modifier.fillMaxWidth(),
                            textStyle = MaterialTheme.typography.bodyMedium,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PillButton(stringResource(R.string.memory_save)) { vm.editMemory(m.id, editing!!.second); editing = null }
                            TextButton(onClick = { editing = null }) { Text(stringResource(R.string.cancel)) }
                        }
                    } else {
                        Text(m.text, style = MaterialTheme.typography.bodyMedium)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                SmallBadge(stringResource(memoryKindLabel(m.kind)), filled = true)
                                m.confidence?.let { SmallBadge(stringResource(memoryConfidenceLabel(it)), filled = false) }
                                SmallBadge(stringResource(if (m.source == "explicit") R.string.source_explicit else R.string.source_derived), filled = false)
                                if (m.pinned) SmallBadge(stringResource(R.string.memory_pinned), filled = true)
                            }
                            IconButton(onClick = { vm.pinMemory(m.id, !m.pinned) }, modifier = Modifier.size(32.dp)) {
                                Icon(Icons.Default.Star, stringResource(R.string.memory_pin), tint = if (m.pinned) MaterialTheme.colorScheme.primary else palette.iconGray, modifier = Modifier.size(16.dp))
                            }
                            IconButton(onClick = { editing = m.id to m.text }, modifier = Modifier.size(32.dp)) {
                                Icon(Icons.Default.Create, stringResource(R.string.memory_edit), tint = palette.iconGray, modifier = Modifier.size(16.dp))
                            }
                            IconButton(onClick = { vm.deleteMemory(m.id) }, modifier = Modifier.size(32.dp)) {
                                Icon(Icons.Default.Delete, stringResource(R.string.memory_delete), tint = palette.iconGray, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
            if (state.memoriesHasMore) {
                PillButton(stringResource(R.string.memory_load_more, (state.memoriesTotal - state.memories.size).coerceAtLeast(0))) {
                    vm.loadMoreMemories()
                }
            }
        }
    }

    if (state.isAdmin) {
        AdminZoneHeader()
        SectionCard(stringResource(R.string.memory_enable_title), stringResource(R.string.memory_enable_intro)) {
            SwitchRow(stringResource(R.string.memory_enable_label), checked = state.memoryEnabledAdmin, onChecked = { vm.setMemoryEnabledAdmin(it) })
        }
        SectionCard(stringResource(R.string.memory_tuning_title), stringResource(R.string.memory_tuning_intro)) {
            NumField(stringResource(R.string.tune_budget), state.tuneBudget) { vm.setTuneField("budget", it) }
            NumField(stringResource(R.string.tune_topk), state.tuneTopK) { vm.setTuneField("topk", it) }
            NumField(stringResource(R.string.tune_trunc), state.tuneMsgTrunc) { vm.setTuneField("trunc", it) }
            NumField(stringResource(R.string.tune_cap), state.tuneTranscriptCap) { vm.setTuneField("cap", it) }
            // Dream tuning (issue #15 parity with the web memory admin card).
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1f)) { NumField(stringResource(R.string.tune_dream_deadline), state.dreamDeadlineSec) { vm.setTuneField("dreamdeadline", it) } }
                Column(Modifier.weight(1f)) { NumField(stringResource(R.string.tune_dream_chunk), state.dreamChunk) { vm.setTuneField("dreamchunk", it) } }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1f)) { NumField(stringResource(R.string.tune_dream_insights), state.dreamInsights) { vm.setTuneField("dreaminsights", it) } }
                Column(Modifier.weight(1f)) { NumField(stringResource(R.string.tune_dream_rebuild), state.dreamCardRebuild) { vm.setTuneField("dreamrebuild", it) } }
            }
            PillButton(stringResource(R.string.save)) { vm.saveTuning() }
        }
        SectionCard(stringResource(R.string.task_fact_title), stringResource(R.string.task_fact_intro)) {
            TaskEditor(state.factTask, state.chatCapableModels, stringResource(R.string.schedule_after_each), stringResource(R.string.task_fact_never),
                display = { state.modelLabels[it] ?: it },
                onChange = { vm.setTaskField("fact", it) }, onSave = { vm.saveTask("memory.events.fact_extraction", state.factTask) })
        }
        SectionCard(stringResource(R.string.task_summary_title), stringResource(R.string.task_summary_intro)) {
            TaskEditor(state.summaryTask, state.chatCapableModels, stringResource(R.string.schedule_after_each), stringResource(R.string.task_summary_never),
                display = { state.modelLabels[it] ?: it },
                onChange = { vm.setTaskField("summary", it) }, onSave = { vm.saveTask("memory.events.thread_summary", state.summaryTask) })
        }
        SectionCard(stringResource(R.string.task_dream_title), stringResource(R.string.task_dream_intro)) {
            TaskEditor(state.dreamTask, state.chatCapableModels, stringResource(R.string.schedule_after_each), stringResource(R.string.task_dream_never),
                display = { state.modelLabels[it] ?: it },
                onChange = { vm.setTaskField("dream", it) }, onSave = { vm.saveTask("memory.events.dreaming", state.dreamTask) })
        }
    }
}

// ── Lemonade tab (admin) ─────────────────────────────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LemonadeTab(vm: SettingsViewModel, state: SettingsUiState) {
    val palette = LocalYashaPalette.current

    SectionCard(stringResource(R.string.server_title)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(
                when (state.serverOnline) { true -> Color(0xFF1E8E3E); false -> Color(0xFFD93025); null -> palette.iconGray },
            ))
            Text(stringResource(if (state.serverOnline == true) R.string.server_online else R.string.server_offline), style = MaterialTheme.typography.bodyMedium)
        }
        Text(
            if (state.serverLoaded.isEmpty()) stringResource(R.string.none_loaded) else state.serverLoaded.joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = palette.iconGray,
        )
    }

    SectionCard(stringResource(R.string.chat_models_title), stringResource(R.string.chat_models_intro)) {
        DropdownField(
            stringResource(R.string.fast_model), state.fastModel, state.chatCapableModels,
            stringResource(R.string.model_pick), null, display = { state.modelLabels[it] ?: it },
        ) { vm.setLemonadeField("fast", it) }
        DropdownField(
            stringResource(R.string.smart_model), state.smartModel, state.chatCapableModels,
            stringResource(R.string.model_pick), stringResource(R.string.model_none), display = { state.modelLabels[it] ?: it },
        ) { vm.setLemonadeField("smart", it) }
        PillButton(stringResource(R.string.save)) { vm.saveChatModels() }
    }

    SectionCard(stringResource(R.string.chat_limits_title), stringResource(R.string.chat_limits_intro)) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.chat_window), state.chatWindowMessages) { vm.setLemonadeField("window", it) } }
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.chat_timeout), state.chatTimeoutSec) { vm.setLemonadeField("chattimeout", it) } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.chat_max_images), state.chatMaxImages) { vm.setLemonadeField("maximg", it) } }
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.chat_max_window_images), state.chatMaxWindowImages) { vm.setLemonadeField("maxwin", it) } }
        }
        NumField(stringResource(R.string.chat_max_upload), state.chatMaxUploadMb) { vm.setLemonadeField("maxupload", it) }
        NumField(stringResource(R.string.chat_tool_result_max), state.mcpToolResultChars) { vm.setLemonadeField("toolres", it) }
        PillButton(stringResource(R.string.save)) { vm.saveChatLimits() }
    }

    SectionCard(
        stringResource(R.string.models_title),
        stringResource(R.string.models_intro),
        action = { if (state.mutationsEnabled) SmallBadge(stringResource(R.string.mutations_off), filled = false) },
    ) {
        if (state.catalogError) Text(stringResource(R.string.catalog_failed), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        state.catalog.forEach { m ->
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(m.id, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    SmallBadge(if (m.downloaded) stringResource(R.string.model_downloaded) else stringResource(R.string.model_not_downloaded), filled = m.downloaded)
                    if (m.size.isNotEmpty()) Text(m.size, fontSize = 11.sp, color = palette.iconGray)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (m.downloaded) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.clickable { vm.modelAction("load", m.id) }) {
                            Icon(Icons.Default.PlayArrow, stringResource(R.string.action_load), tint = palette.iconGray, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.action_load), fontSize = 12.sp, color = palette.iconGray)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.clickable { vm.modelAction("unload", m.id) }) {
                            Icon(Icons.Default.Close, stringResource(R.string.action_unload), tint = palette.iconGray, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.action_unload), fontSize = 12.sp, color = palette.iconGray)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.clickable { vm.modelAction("delete", m.id) }) {
                            Icon(Icons.Default.Delete, stringResource(R.string.action_delete), tint = palette.iconGray, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.action_delete), fontSize = 12.sp, color = palette.iconGray)
                        }
                    }
                }
            }
        }
    }

    SectionCard(stringResource(R.string.registry_title), stringResource(R.string.registry_intro)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(
                value = state.registryQuery,
                onValueChange = { vm.setRegistryQuery(it) },
                placeholder = { Text(stringResource(R.string.registry_hint), color = palette.iconGray) },
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
            )
            PillButton(stringResource(R.string.registry_search)) { vm.registrySearch() }
        }
        if (state.busy && !state.registryDone) CircularProgressIndicator(Modifier.size(20.dp))
        if (state.registryDone && state.registryResults.isEmpty()) {
            Text(stringResource(R.string.no_results), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        }
        state.registryResults.forEach { name ->
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { vm.loadVariants(name) }.padding(vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (state.variantsFor == name && state.variants.isEmpty()) {
                    Text(stringResource(R.string.loading), fontSize = 11.sp, color = palette.iconGray)
                }
                if (state.variantsFor == name) {
                    state.variants.forEach { v ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 8.dp)) {
                            Text(v, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.clickable { vm.pullVariant(v) }) {
                                Icon(Icons.Default.Add, stringResource(R.string.action_pull), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
        }
    }

    SectionCard(stringResource(R.string.admin_mcp_title), stringResource(R.string.admin_mcp_intro)) {
        SwitchRow(stringResource(R.string.admin_mcp_global), checked = state.adminMcpEnabled, onChecked = { vm.setMcpGlobalEnabled(it) })
        SwitchRow(
            stringResource(R.string.admin_mcp_user_private),
            checked = state.adminMcpUserPrivateUrls,
            onChecked = { vm.setMcpUserPrivateUrls(it) },
        )
        SwitchRow(
            stringResource(R.string.admin_mcp_user_servers),
            checked = state.adminMcpUserServersEnabled,
            onChecked = { vm.setMcpUserServersEnabled(it) },
        )
        if (state.mcpLoaded && state.mcpServers.isEmpty()) {
            Text(stringResource(R.string.admin_mcp_none), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        }
        state.mcpServers.forEach { srv ->
            var showTools by remember(srv) { mutableStateOf(false) }
            var showHeaders by remember(srv) { mutableStateOf(false) }
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(srv.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f, fill = false))
                    if (srv.builtin) SmallBadge(stringResource(R.string.admin_mcp_builtin), filled = true)
                    srv.owner?.let { SmallBadge(stringResource(R.string.admin_mcp_owner, it), filled = false) }
                }
                srv.url?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.iconGray) }
                srv.headers?.keys?.sorted()?.let { keys ->
                    Text(keys.joinToString(" · ") { "$it: ••••" }, fontSize = 11.sp, color = palette.iconGray)
                }
                Text(
                    if (srv.health.ok) stringResource(R.string.admin_mcp_healthy, srv.health.toolCount)
                    else stringResource(R.string.admin_mcp_unhealthy, srv.health.error ?: "error"),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (srv.health.ok) Color(0xFF1E8E3E) else MaterialTheme.colorScheme.error,
                )
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { vm.mcpAction("check", id = srv.id) }) { Text(stringResource(R.string.admin_mcp_check), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                    TextButton(onClick = { vm.mcpAction("toggle", id = srv.id) }) { Text(stringResource(if (srv.enabled) R.string.admin_mcp_disable else R.string.admin_mcp_enable), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                    if (!srv.builtin) {
                        TextButton(onClick = { vm.mcpAction("delete", id = srv.id) }) { Text(stringResource(R.string.admin_mcp_delete), fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
                    }
                    if (!srv.builtin && srv.owner == null) {
                        TextButton(onClick = { showHeaders = !showHeaders }) { Text(stringResource(R.string.mcp_headers), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                    }
                    TextButton(onClick = { showTools = !showTools }) { Text(stringResource(if (showTools) R.string.admin_mcp_hide_tools else R.string.admin_mcp_show_tools), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }
                }
                if (showHeaders) {
                    McpHeadersForm(
                        existing = srv.headers?.keys?.sorted() ?: emptyList(),
                        onSave = { patch ->
                            if (patch.isEmpty()) { showHeaders = false; return@McpHeadersForm }
                            vm.mcpAction("update", id = srv.id, headers = patch, onDone = { if (it) showHeaders = false })
                        },
                        onCancel = { showHeaders = false },
                    )
                }
                if (showTools) {
                    McpToolList(
                        tools = srv.tools,
                        disabledTools = srv.disabledTools,
                        onExclude = { tool -> vm.mcpAction("update", id = srv.id, disabledTools = srv.disabledTools + tool) },
                        onInclude = { tool -> vm.mcpAction("update", id = srv.id, disabledTools = srv.disabledTools.filter { it != tool }) },
                    )
                }
            }
        }
        var adding by remember { mutableStateOf(false) }
        var newName by remember { mutableStateOf("") }
        var newUrl by remember { mutableStateOf("") }
        var newHeaders by remember { mutableStateOf(mapOf<String, String>()) }
        if (adding) {
            OutlinedTextField(newName, { newName = it }, singleLine = true, label = { Text(stringResource(R.string.admin_mcp_name)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(newUrl, { newUrl = it }, singleLine = true, label = { Text(stringResource(R.string.admin_mcp_url)) }, modifier = Modifier.fillMaxWidth())
            McpHeadersForm(existing = null, onChange = { newHeaders = it })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                PillButton(stringResource(R.string.admin_mcp_add), enabled = newName.isNotBlank() && newUrl.isNotBlank()) {
                    vm.mcpAction(
                        "add",
                        name = newName.trim(),
                        url = newUrl.trim(),
                        headers = newHeaders.ifEmpty { null },
                        onDone = { ok ->
                            if (ok) {
                                newName = ""; newUrl = ""; newHeaders = emptyMap(); adding = false
                            }
                        },
                    )
                }
                TextButton(onClick = { adding = false; newName = ""; newUrl = ""; newHeaders = emptyMap() }) { Text(stringResource(R.string.cancel), color = MaterialTheme.colorScheme.primary) }
            }
        } else {
            PillButton(stringResource(R.string.admin_mcp_add_server)) { adding = true }
        }
    }
}

// ── Jobs tab (admin) ─────────────────────────────────────────────────────────

@Composable
private fun JobsTab(vm: SettingsViewModel, state: SettingsUiState) {
    val palette = LocalYashaPalette.current
    SectionCard(stringResource(R.string.task_title_gen_title), stringResource(R.string.task_title_gen_intro)) {
        TaskEditor(
            cfg = state.titleTask,
            models = state.chatCapableModels,
            afterEachLabel = stringResource(R.string.schedule_after_first),
            neverWarning = stringResource(R.string.task_title_gen_never),
            onChange = { vm.setTaskField("title", it) },
            onSave = { vm.saveTask("chat.title_generation", state.titleTask) },
        )
    }
    // Mirrors the web jobs tab: audio transcription lives here, under title generation.
    SectionCard(stringResource(R.string.task_audio_title), stringResource(R.string.task_audio_intro)) {
        TaskEditor(
            cfg = state.audioTask,
            models = state.chatCapableModels,
            afterEachLabel = stringResource(R.string.schedule_after_each),
            neverWarning = stringResource(R.string.task_audio_never),
            onChange = { vm.setTaskField("audio", it) },
            onSave = { vm.saveTask("chat.audio_transcription", state.audioTask) },
        )
    }
    SectionCard(stringResource(R.string.runtime_title), stringResource(R.string.runtime_intro)) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.runtime_concurrency), state.runConcurrency) { vm.setRuntimeField("conc", it) } }
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.runtime_retention), state.runRetentionDays) { vm.setRuntimeField("retention", it) } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.runtime_claim), state.runClaimSec) { vm.setRuntimeField("claim", it) } }
            Column(Modifier.weight(1f)) { NumField(stringResource(R.string.runtime_stale), state.runStaleSec) { vm.setRuntimeField("stale", it) } }
        }
        PillButton(stringResource(R.string.save)) { vm.saveRuntime() }
    }

    SectionCard(
        stringResource(R.string.jobs_title),
        action = { TextButton(onClick = { vm.loadJobs() }) { Text(stringResource(R.string.refresh), fontSize = 13.sp) } },
    ) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            listOf("active", "pending", "running", "succeeded", "failed", "cancelled").forEach { f ->
                val active = state.jobsFilter == f
                Box(
                    Modifier.clip(CircleShape).border(1.dp, palette.composerOutline, CircleShape)
                        .background(if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                        .clickable { vm.setJobsFilter(f) }.padding(horizontal = 10.dp, vertical = 5.dp),
                ) { Text(f, fontSize = 11.sp, color = palette.iconGray) }
            }
        }
        if (state.jobs.isEmpty()) Text(stringResource(R.string.jobs_empty), style = MaterialTheme.typography.bodyMedium, color = palette.iconGray)
        state.jobs.forEach { j ->
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(j.type, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    SmallBadge(j.status, filled = j.status == "running" || j.status == "pending")
                    Text("${j.attempts}/${j.maxAttempts}", fontSize = 11.sp, color = palette.iconGray, modifier = Modifier.padding(start = 6.dp))
                }
                if (j.scope.isNotEmpty()) Text(j.scope, style = MaterialTheme.typography.bodySmall, color = palette.iconGray, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (j.lastError.isNotEmpty()) Text(j.lastError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (j.status == "pending") {
                        Text(stringResource(R.string.job_cancel), fontSize = 12.sp, color = palette.iconGray, modifier = Modifier.clickable { vm.jobAction("cancel", j.id) })
                    }
                    if (j.status == "failed") {
                        Text(stringResource(R.string.job_retry), fontSize = 12.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable { vm.jobAction("retry", j.id) })
                    }
                }
            }
        }
        Text(
            stringResource(R.string.job_retry_all),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(top = 4.dp).clickable { vm.jobAction("retryAllFailed", "") },
        )
    }
}

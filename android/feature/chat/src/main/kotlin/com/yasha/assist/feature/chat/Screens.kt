package com.yasha.assist.feature.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import com.yasha.assist.core.design.LocalYashaPalette
import com.yasha.assist.core.markdown.YashaMarkdown
import com.yasha.assist.core.net.ThreadRowDto
import java.util.Base64
import kotlin.math.min
import kotlinx.coroutines.launch

@Composable
fun YashaAppRoot(
    vm: ChatViewModel,
    svm: SettingsViewModel,
    assistTick: Long = 0L,
    pendingProvider: (() -> Pair<String, List<String>>?)? = null,
    onPendingApplied: () -> Unit = {},
    threadTick: Long = 0L,
    threadProvider: (() -> String?)? = null,
    onThreadApplied: () -> Unit = {},
) {
    val state by vm.state.collectAsState()
    var showSettings by remember { mutableStateOf(false) }
    var appliedTick by remember { mutableStateOf(0L) }
    var appliedThreadTick by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) { vm.start() }
    // Issue #14: coming back to the app with connectivity must recover the
    // session view immediately (the offline banner's auto-retry also runs).
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.onResume()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    // The tick may arrive before the session probe flips signedIn (cold start) —
    // latch on the tick and apply exactly once when the session is ready.
    LaunchedEffect(assistTick, state.signedIn) {
        if (assistTick > 0 && assistTick > appliedTick && state.signedIn) {
            appliedTick = assistTick
            showSettings = false
            vm.newChat()
            pendingProvider?.invoke()?.let { (text, urls) -> vm.prefillAssist(text, urls) }
            onPendingApplied()
        }
    }
    LaunchedEffect(threadTick, state.signedIn) {
        if (threadTick > 0 && threadTick > appliedThreadTick && state.signedIn) {
            appliedThreadTick = threadTick
            showSettings = false
            threadProvider?.invoke()?.let { vm.openThread(it) }
            onThreadApplied()
        }
    }
    when {
        state.checkingSession -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        !state.signedIn -> LoginScreen(vm, state)
        showSettings -> SettingsScreen(svm, onBack = { showSettings = false })
        else -> Home(vm, state, onSettings = { showSettings = true })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LoginScreen(vm: ChatViewModel, state: ChatUiState) {
    var url by remember { mutableStateOf(state.baseUrl) }
    var email by remember { mutableStateOf(state.email) }
    var password by remember { mutableStateOf("") }
    Scaffold { pad ->
        Box(
            Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).imePadding(),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier.fillMaxWidth().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                SparkleLogo(64.dp)
                Spacer(Modifier.height(20.dp))
                Text(stringResource(R.string.sign_in_title), style = MaterialTheme.typography.headlineMedium)
                Spacer(Modifier.height(24.dp))
                OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text(stringResource(R.string.server_url)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text(stringResource(R.string.login_identifier)) }, singleLine = true, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(stringResource(R.string.password)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                state.error?.let { code ->
                    Spacer(Modifier.height(12.dp))
                    Text(stringResource(ErrorStrings.messageRes(code)), color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(16.dp))
                Box(
                    Modifier.fillMaxWidth().height(48.dp).clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable(enabled = !state.busy) { vm.signIn(url, email, password) },
                    contentAlignment = Alignment.Center,
                ) {
                    if (state.busy) CircularProgressIndicator(Modifier.size(20.dp))
                    else Text(stringResource(R.string.sign_in_button), color = MaterialTheme.colorScheme.onPrimary)
                }
            }
        }
    }
}

@Composable
private fun Home(vm: ChatViewModel, state: ChatUiState, onSettings: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var pendingDelete by remember { mutableStateOf<ThreadRowDto?>(null) }
    val errCode = state.error
    if (errCode != null) {
        val errMsg = stringResource(ErrorStrings.messageRes(errCode))
        LaunchedEffect(errCode) {
            snackbar.showSnackbar(errMsg)
            vm.dismissError()
        }
    }
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            YashaDrawer(
                state = state,
                onNewChat = { vm.newChat(); scope.launch { drawerState.close() } },
                onThread = { row -> vm.openThread(row.threadId); scope.launch { drawerState.close() } },
                onThreadLong = { pendingDelete = it },
                onSetup = { scope.launch { drawerState.close() }; onSettings() },
                onSignOut = { scope.launch { drawerState.close() }; vm.signOut() },
            )
        },
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            contentWindowInsets = WindowInsets(0.dp, 0.dp, 0.dp, 0.dp),
            topBar = {
                Column {
                    TopBar(vm, state, onMenu = { scope.launch { drawerState.open() } })
                    // Issue #14: server unreachable with a valid stored token —
                    // session preserved, banner + background/auto retry instead
                    // of the login form.
                    if (state.offline) OfflineBanner(vm)
                }
            },
        ) { pad ->
            if (state.threadId == null && state.messages.isEmpty()) {
                HomeScreen(vm, state, Modifier.padding(pad))
            } else {
                ChatScreen(vm, state, Modifier.padding(pad))
            }
        }
    }
    pendingDelete?.let { row ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.delete_thread)) },
            text = { Text(stringResource(R.string.delete_thread_message)) },
            confirmButton = {
                TextButton(onClick = { vm.deleteThread(row.threadId); pendingDelete = null }) {
                    Text(stringResource(R.string.delete_confirm), color = MaterialTheme.colorScheme.primary)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun OfflineBanner(vm: ChatViewModel) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.error_network),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = { vm.retryNow() }) {
            Text(stringResource(R.string.retry), style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun TopBar(vm: ChatViewModel, state: ChatUiState, onMenu: () -> Unit) {
    val palette = LocalYashaPalette.current
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onMenu) {
            Icon(Icons.Default.Menu, stringResource(R.string.open_drawer), tint = MaterialTheme.colorScheme.onSurface)
        }
        ModelPicker(vm, state)
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun ModelPicker(vm: ChatViewModel, state: ChatUiState) {
    val palette = LocalYashaPalette.current
    var open by remember { mutableStateOf(false) }
    if (state.models.isEmpty()) return
    val fastLabel = stringResource(R.string.model_fast)
    val smartLabel = stringResource(R.string.model_smart)
    // Same display as the web picker: model name + fast/smart role hint (Q4).
    fun label(id: String?): String {
        val m = state.models.find { it.id == id } ?: return id.orEmpty()
        val base = m.name?.takeIf { it.isNotEmpty() } ?: m.id
        return when (m.label) {
            "fast" -> "$base · $fastLabel"
            "smart" -> "$base · $smartLabel"
            else -> base
        }
    }
    val current = state.pickedModel ?: state.defaultModel
    Box {
        Row(
            Modifier.clip(CircleShape).clickable { open = true }.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label(current),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 180.dp),
            )
            Icon(Icons.Default.ArrowDropDown, null, tint = palette.iconGray)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            state.models.forEach { m ->
                DropdownMenuItem(
                    text = { Text(label(m.id), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = { if (current == m.id) Icon(Icons.Default.Check, null, Modifier.size(18.dp)) },
                    onClick = { vm.pickModel(m.id); open = false },
                )
            }
        }
    }
}

@Composable
private fun YashaDrawer(
    state: ChatUiState,
    onNewChat: () -> Unit,
    onThread: (ThreadRowDto) -> Unit,
    onThreadLong: (ThreadRowDto) -> Unit,
    onSetup: () -> Unit,
    onSignOut: () -> Unit,
) {
    val palette = LocalYashaPalette.current
    var accountMenu by remember { mutableStateOf(false) }
    ModalDrawerSheet(
        drawerShape = RoundedCornerShape(topEnd = 28.dp, bottomEnd = 28.dp),
        drawerContainerColor = palette.drawerSurface,
    ) {
        Column(Modifier.fillMaxSize().systemBarsPadding().padding(horizontal = 12.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(start = 8.dp, top = 10.dp, bottom = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SparkleLogo(26.dp)
                Spacer(Modifier.width(14.dp))
                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge)
            }
            DrawerRow(Icons.Default.Create, stringResource(R.string.new_chat), selected = false, onClick = { onNewChat() })
            Text(
                stringResource(R.string.recents),
                style = MaterialTheme.typography.labelLarge,
                color = palette.iconGray,
                modifier = Modifier.padding(start = 16.dp, top = 22.dp, bottom = 6.dp),
            )
            if (state.threads.isEmpty()) {
                Text(
                    stringResource(R.string.threads_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.iconGray,
                    modifier = Modifier.padding(start = 16.dp, top = 4.dp),
                )
                Spacer(Modifier.weight(1f))
            } else {
                LazyColumn(Modifier.weight(1f)) {
                    items(state.threads, key = { it.threadId }) { row ->
                        DrawerRow(
                            icon = null,
                            label = row.title.ifEmpty { stringResource(R.string.image_thread) },
                            selected = state.threadId == row.threadId,
                            onClick = { onThread(row) },
                            onLongClick = { onThreadLong(row) },
                        )
                    }
                }
            }
            Box {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).clickable { accountMenu = true }
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val initial = state.email.trim().firstOrNull()?.uppercaseChar() ?: '?'
                    Box(
                        Modifier.size(38.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(initial.toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.titleMedium)
                    }
                    Spacer(Modifier.width(14.dp))
                    Text(
                        state.email.ifEmpty { stringResource(R.string.account) },
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(Icons.Default.MoreVert, stringResource(R.string.options), tint = palette.iconGray)
                }
                DropdownMenu(expanded = accountMenu, onDismissRequest = { accountMenu = false }) {
                    DropdownMenuItem(
                        leadingIcon = { Icon(Icons.Default.Settings, null) },
                        text = { Text(stringResource(R.string.settings_title)) },
                        onClick = { accountMenu = false; onSetup() },
                    )
                    DropdownMenuItem(
                        leadingIcon = { Icon(Icons.Default.ExitToApp, null) },
                        text = { Text(stringResource(R.string.sign_out)) },
                        onClick = { accountMenu = false; onSignOut() },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DrawerRow(
    icon: ImageVector?,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val palette = LocalYashaPalette.current
    val shape = RoundedCornerShape(28.dp)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(shape)
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = palette.iconGray)
            Spacer(Modifier.width(20.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun HomeScreen(vm: ChatViewModel, state: ChatUiState, modifier: Modifier) {
    val palette = LocalYashaPalette.current
    Box(
        modifier.fillMaxSize()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent, palette.homeGlow))),
    ) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            SparkleLogo(76.dp)
            Spacer(Modifier.height(16.dp))
            val name = state.email.substringBefore('@').trim()
            Text(
                if (name.isEmpty()) stringResource(R.string.greeting_plain)
                else stringResource(R.string.greeting_name, name),
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, lineHeight = 36.sp),
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
        }
        Composer(vm, state, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun ChatScreen(vm: ChatViewModel, state: ChatUiState, modifier: Modifier) {
    val listState = rememberLazyListState()
    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.text?.length) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }
    Column(modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
        ) {
            val lastId = state.messages.lastOrNull()?.id
            items(state.messages, key = { it.id }) { msg ->
                MessageRow(msg, isLast = msg.id == lastId, onRetryTranscribe = vm::retryTranscribe, onRetryTurn = vm::retryTurn)
            }
        }
        Composer(vm, state, Modifier.fillMaxWidth())
    }
}

@Composable
private fun ToolChips(tools: List<UiTool>) {
    val palette = LocalYashaPalette.current
    val runningLabel = stringResource(R.string.tool_running)
    val doneLabel = stringResource(R.string.tool_done)
    val errorLabel = stringResource(R.string.tool_error)
    val truncatedLabel = stringResource(R.string.tool_truncated)
    // One chip per row (issue #2): inline chips overflowed narrow screens.
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), horizontalAlignment = Alignment.Start) {
        tools.forEach { tool ->
            var expanded by remember(tool.server, tool.name) { mutableStateOf(false) }
            // Amber warn state when the server cut the output (issue #8);
            // errors keep the red tint.
            val warn = tool.truncated && tool.status != "error"
            val label = when {
                tool.status == "running" -> runningLabel
                tool.status == "error" -> errorLabel
                warn -> truncatedLabel
                else -> doneLabel
            }
            val tint = when {
                tool.status == "error" -> MaterialTheme.colorScheme.error
                warn -> palette.warnAmber
                else -> palette.disclaimer
            }
            val expandable = !tool.args.isNullOrEmpty() || tool.result != null
            Row(
                Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(palette.userBubble.copy(alpha = 0.35f))
                    .then(if (expandable) Modifier.clickable { expanded = !expanded } else Modifier)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                when (tool.status) {
                    "running" -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = tint)
                    "error" -> Icon(rememberVectorPainter(Icons.Default.Close), null, Modifier.size(13.dp), tint)
                    else -> Icon(rememberVectorPainter(Icons.Default.Check), null, Modifier.size(13.dp), tint)
                }
                Text(
                    "${tool.server} · ${tool.name} · $label",
                    style = MaterialTheme.typography.labelSmall,
                    color = tint,
                )
                if (expandable) {
                    Icon(
                        rememberVectorPainter(Icons.Default.ArrowDropDown),
                        null,
                        Modifier.size(16.dp).rotate(if (expanded) 180f else 0f),
                        tint,
                    )
                }
            }
            if (expanded && expandable) ToolDetails(tool)
        }
    }
}

// Openable tool card (web parity): pretty-printed arguments + the tool's
// result/error text, selectable for copy.
private val prettyToolJson = kotlinx.serialization.json.Json { prettyPrint = true }

private fun formatToolArgs(args: String): String = try {
    prettyToolJson.parseToJsonElement(args).toString()
} catch (_: Exception) {
    args
}

@Composable
private fun ToolDetails(tool: UiTool) {
    val palette = LocalYashaPalette.current
    SelectionContainer {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(palette.userBubble.copy(alpha = 0.22f))
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!tool.args.isNullOrEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        stringResource(R.string.tool_args),
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.disclaimer,
                    )
                    Text(
                        formatToolArgs(tool.args),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (tool.result != null) {
                    Text(
                        stringResource(R.string.tool_result),
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.disclaimer,
                    )
                    Text(
                        tool.result,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = if (tool.status == "error") MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurface,
                    )
                } else {
                    Text(
                        stringResource(R.string.tool_no_result),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.disclaimer,
                    )
                }
            }
        }
    }
}

@Composable
private fun MessageRow(msg: UiMessage, isLast: Boolean, onRetryTranscribe: (String) -> Unit, onRetryTurn: (String) -> Unit) {
    val palette = LocalYashaPalette.current
    val context = LocalContext.current
    val appName = stringResource(R.string.app_name)
    val copiedMsg = stringResource(R.string.copied)
    val shareTitle = stringResource(R.string.share_via)
    if (msg.role == "user") {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.End) {
            Column(
                Modifier.widthIn(max = 320.dp),
                horizontalAlignment = Alignment.End,
            ) {
                Column(
                    Modifier
                        .widthIn(max = 320.dp)
                        .clip(RoundedCornerShape(28.dp)).background(palette.userBubble)
                        .padding(horizontal = 20.dp, vertical = 13.dp),
                ) {
                    if (msg.images.isNotEmpty()) {
                        msg.images.forEach { url -> AttachmentThumb(url, Modifier.size(160.dp).clip(RoundedCornerShape(20.dp))) }
                        if (msg.text.isNotEmpty()) Spacer(Modifier.height(10.dp))
                    }
                    if (msg.audio != null) {
                        VoiceMessage(msg, onRetry = { onRetryTranscribe(msg.id) })
                        if (msg.text.isNotEmpty()) Spacer(Modifier.height(10.dp))
                    }
                    if (msg.text.isNotEmpty()) {
                        Text(msg.text, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp, lineHeight = 24.sp))
                    }
                }
                msg.turnError?.let { code ->
                    Row(
                        Modifier.padding(top = 6.dp, end = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            stringResource(if (code == "timeout") R.string.turn_timeout else R.string.error_upstream),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = { onRetryTurn(msg.id) }, modifier = Modifier.height(28.dp)) {
                            Text(stringResource(R.string.job_retry), style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
    } else {
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            if (msg.images.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    msg.images.forEach { url -> AttachmentThumb(url, Modifier.size(96.dp).clip(RoundedCornerShape(16.dp))) }
                }
                if (msg.text.isNotEmpty()) Spacer(Modifier.height(10.dp))
            }
            if (msg.segments.isNotEmpty()) {
                // Ordered text/tool interleaving (issue #7): chips render at
                // their execution position between the surrounding text.
                val lastTextIndex = msg.segments.indexOfLast { it is UiSegment.Text }
                msg.segments.forEachIndexed { i, seg ->
                    when (seg) {
                        is UiSegment.Tools -> {
                            ToolChips(seg.tools)
                            Spacer(Modifier.height(8.dp))
                        }
                        is UiSegment.Text -> YashaMarkdown(
                            content = seg.text,
                            streaming = msg.streaming && i == lastTextIndex,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (msg.streaming && msg.text.isEmpty()) {
                    // Chips streamed before the first token: shimmer stays below.
                    ThinkingLoader()
                }
            } else {
                if (msg.tools.isNotEmpty()) {
                    ToolChips(msg.tools)
                    Spacer(Modifier.height(8.dp))
                }
                if (msg.streaming && msg.text.isEmpty()) {
                    // Awaiting the first token: animated shimmer (web parity);
                    // the old " ▌" cursor on empty text rendered as a black block.
                    ThinkingLoader()
                } else {
                    YashaMarkdown(
                        content = msg.text,
                        streaming = msg.streaming,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (!msg.streaming && msg.text.isNotEmpty()) {
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    ActionIcon(painterResource(R.drawable.ic_copy), stringResource(R.string.copy_action)) { copyText(context, msg.text, appName, copiedMsg) }
                    ActionIcon(rememberVectorPainter(Icons.Default.Share), shareTitle) { shareText(context, msg.text, shareTitle) }
                }
                if (isLast) {
                    Text(
                        stringResource(R.string.disclaimer),
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                        color = palette.disclaimer,
                        modifier = Modifier.padding(top = 14.dp, bottom = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ActionIcon(painter: Painter, desc: String, onClick: () -> Unit) {
    val palette = LocalYashaPalette.current
    Box(Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(painter, desc, tint = palette.iconGray, modifier = Modifier.size(20.dp))
    }
}

// Awaiting-first-token loader: a shimmer bar sweeping a highlight, mirroring
// the web `.shimmer` class (1.4 s cycle, ~10 % foreground highlight). Drawn on
// a Canvas so per-frame animation stays in the draw phase (ANR-safe).
@Composable
private fun ThinkingLoader() {
    val transition = rememberInfiniteTransition(label = "thinking")
    val slide by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Restart),
        label = "shimmer",
    )
    val base = MaterialTheme.colorScheme.surfaceVariant
    val highlight = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f)
    Canvas(Modifier.width(192.dp).height(14.dp).clip(CircleShape)) {
        drawRect(base.copy(alpha = 0.7f))
        val x = (slide * 2f - 1f) * size.width
        drawRect(
            Brush.linearGradient(
                listOf(Color.Transparent, highlight, Color.Transparent),
                start = Offset(x, 0f),
                end = Offset(x + size.width, 0f),
            ),
        )
    }
}

// Voice bubble (AUDIO-REFACTO-PLAN §6/§7): playback of the stored WAV data
// URL + the background caption states (pending / text / failed+retry).
@Composable
private fun VoiceMessage(msg: UiMessage, onRetry: () -> Unit) {
    val palette = LocalYashaPalette.current
    val context = LocalContext.current
    var playing by remember(msg.id) { mutableStateOf(false) }
    val player = remember { android.media.MediaPlayer() }
    DisposableEffect(Unit) {
        onDispose { runCatching { player.release() } }
    }
    val scope = rememberCoroutineScope()
    Column {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)
                    .clickable {
                        val url = msg.audio
                        if (url == null) return@clickable
                        if (playing) {
                            runCatching { player.reset() }
                            playing = false
                        } else {
                            playing = true
                            scope.launch(kotlinx.coroutines.Dispatchers.IO) {
                                val ok = runCatching {
                                    val bytes = Base64.getDecoder().decode(url.substringAfter("base64,", ""))
                                    val f = java.io.File.createTempFile("yasha-voice", ".wav", context.cacheDir)
                                    f.writeBytes(bytes)
                                    runCatching { player.reset() }
                                    player.setDataSource(f.absolutePath)
                                    player.setOnCompletionListener {
                                        playing = false
                                        f.delete()
                                    }
                                    player.prepare()
                                    player.start()
                                }.isSuccess
                                if (!ok) playing = false
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (playing) {
                    Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.onPrimary))
                } else {
                    Icon(
                        rememberVectorPainter(Icons.Default.PlayArrow),
                        stringResource(R.string.audio_play),
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Text(
                stringResource(if (playing) R.string.audio_stop else R.string.audio_play),
                style = MaterialTheme.typography.labelLarge,
                color = palette.iconGray,
            )
        }
        when {
            msg.audioTranscript != null -> Text(
                msg.audioTranscript,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic),
                color = palette.disclaimer,
                modifier = Modifier.padding(top = 8.dp),
            )
            msg.audioTranscriptFailed -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(top = 6.dp),
            ) {
                Text(stringResource(R.string.caption_failed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = onRetry, modifier = Modifier.height(28.dp)) {
                    Text(stringResource(R.string.caption_retry), style = MaterialTheme.typography.labelMedium)
                }
            }
            else -> Text(
                stringResource(R.string.caption_pending),
                style = MaterialTheme.typography.bodySmall,
                color = palette.disclaimer,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

internal fun copyText(context: android.content.Context, text: String, label: String, copiedToast: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, text))
    Toast.makeText(context, copiedToast, Toast.LENGTH_SHORT).show()
}

private fun shareText(context: android.content.Context, text: String, title: String) {
    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), title))
}

@Composable
private fun Composer(vm: ChatViewModel, state: ChatUiState, modifier: Modifier) {
    val palette = LocalYashaPalette.current
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                vm.addAttachment(bytes ?: ByteArray(0), context.contentResolver.getType(uri))
            }.onFailure { vm.addAttachment(ByteArray(0), null) }
        }
    }
    val permission = android.Manifest.permission.RECORD_AUDIO
    var showMicRationale by remember { mutableStateOf(false) }
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.startListening() else vm.clearMicError()
    }
    val micGranted = androidx.core.content.ContextCompat.checkSelfPermission(context, permission) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
    fun onMicTap() {
        if (vm.state.value.listening) vm.stopListening()
        else if (micGranted) vm.startListening()
        else showMicRationale = true
    }
    val bodyStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp, lineHeight = 24.sp)
    Column(modifier.fillMaxWidth().imePadding().navigationBarsPadding()) {
        if (state.noVision) {
            Text(
                stringResource(R.string.no_vision_model),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 4.dp),
            )
        }
        if (state.attachments.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                state.attachments.forEachIndexed { i, dataUrl ->
                    Box {
                        AttachmentThumb(dataUrl, Modifier.size(60.dp).clip(RoundedCornerShape(16.dp)))
                        Box(
                            Modifier.align(Alignment.TopEnd).padding(3.dp).size(20.dp).clip(CircleShape)
                                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.7f))
                                .clickable { vm.removeAttachment(i) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Default.Close, stringResource(R.string.attachment_remove), tint = Color.White, modifier = Modifier.size(13.dp))
                        }
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(1.dp, palette.composerOutline, RoundedCornerShape(28.dp))
                .padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (!state.noVision) {
                Box(
                    Modifier.size(42.dp).clip(RoundedCornerShape(14.dp))
                        .clickable(enabled = !state.busy) { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.Add, stringResource(R.string.attachment_add), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                }
            }
            Box(Modifier.weight(1f).padding(horizontal = 14.dp, vertical = 9.dp)) {
                BasicTextField(
                    value = state.input,
                    onValueChange = vm::setInput,
                    maxLines = 6,
                    textStyle = bodyStyle.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (state.input.isEmpty()) {
                    Text(
                        stringResource(if (state.listening) R.string.mic_listening else R.string.input_hint),
                        style = bodyStyle,
                        color = palette.iconGray,
                        maxLines = 1,
                    )
                }
            }
            if (state.audioEnabled && !state.busy && !state.listening &&
                !(state.audioSmartModel != null && state.pickedModel == state.audioSmartModel)) {
                Box(
                    Modifier.size(42.dp).clip(CircleShape).clickable { onMicTap() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_mic), stringResource(R.string.mic_start), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                }
            }
            if (state.listening) {
                Box(
                    Modifier.size(42.dp).clip(CircleShape).background(MaterialTheme.colorScheme.error)
                        .clickable(onClick = vm::stopListening),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.onError))
                }
                Text(
                    "${state.listenSeconds}s",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(start = 4.dp),
                )
            } else if (state.busy) {
                Box(Modifier.size(42.dp).clip(CircleShape).clickable(onClick = vm::stop), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.onSurfaceVariant))
                }
            } else if (state.input.isNotBlank() || state.attachments.isNotEmpty()) {
                Box(
                    Modifier.size(42.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)
                        .clickable(onClick = vm::send),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.Send, stringResource(R.string.send), tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(20.dp))
                }
            }
        }
        if (showMicRationale) {
            AlertDialog(
                onDismissRequest = { showMicRationale = false },
                title = { Text(stringResource(R.string.mic_permission_title)) },
                text = { Text(stringResource(R.string.mic_permission_body)) },
                confirmButton = {
                    TextButton(onClick = {
                        showMicRationale = false
                        micLauncher.launch(permission)
                    }) { Text(stringResource(R.string.mic_permission_allow)) }
                },
                dismissButton = {
                    TextButton(onClick = { showMicRationale = false }) { Text(stringResource(R.string.cancel)) }
                },
            )
        }
        val micErrorText = stringResource(R.string.mic_error)
        val tooShortText = stringResource(R.string.mic_too_short)
        val tooLargeText = stringResource(R.string.audio_too_large)
        LaunchedEffect(state.micError) {
            val message = when (state.micError) {
                "mic" -> micErrorText
                "too_short" -> tooShortText
                "too_large" -> tooLargeText
                else -> null
            }
            if (message != null) Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
            if (state.micError != null) vm.clearMicError()
        }
    }
}

@Composable
fun SparkleLogo(size: Dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val s = min(this.size.width, this.size.height) / 24f
        // Melting clover: quatrefoil (four overlapping lobes on the diagonals)
        // painted by four soft radial poles bleeding into each other
        // (up red, down green, left yellow, right blue — painted in that order).
        val clover = Path().apply {
            moveTo(12f * s, 5.075f * s)
            arcTo(Rect(2.1f * s, 2.1f * s, 12.5f * s, 12.5f * s), -25.32f, -219.36f, false)
            arcTo(Rect(2.1f * s, 11.5f * s, 12.5f * s, 21.9f * s), -115.32f, -219.36f, false)
            arcTo(Rect(11.5f * s, 11.5f * s, 21.9f * s, 21.9f * s), 154.68f, -219.36f, false)
            arcTo(Rect(11.5f * s, 2.1f * s, 21.9f * s, 12.5f * s), 64.68f, -219.36f, false)
            close()
        }
        fun melt(cx: Float, cy: Float, color: Color) = drawPath(
            clover,
            Brush.radialGradient(
                0f to color,
                0.3f to color.copy(alpha = 0.92f),
                0.62f to color.copy(alpha = 0.5f),
                1f to color.copy(alpha = 0f),
                center = Offset(cx * s, cy * s),
                radius = 10f * s,
            ),
        )
        melt(12f, 4.9f, Color(0xFFEA4335))
        melt(12f, 19.1f, Color(0xFF34A853))
        melt(4.9f, 12f, Color(0xFFFBBC04))
        melt(19.1f, 12f, Color(0xFF4285F4))
    }
}

@Composable
private fun AttachmentThumb(dataUrl: String, modifier: Modifier) {
    val bitmap = remember(dataUrl) {
        runCatching {
            val bytes = Base64.getDecoder().decode(dataUrl.substringAfter("base64,", ""))
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
    if (bitmap != null) {
        Image(bitmap.asImageBitmap(), null, modifier, contentScale = ContentScale.Crop)
    } else {
        Box(modifier.background(Color.DarkGray))
    }
}

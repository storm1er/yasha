package com.yasha.assist.feature.assist

import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.runtime.collectAsState
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Send
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.runtime.collectAsState
import androidx.compose.foundation.gestures.awaitFirstDown
import com.yasha.assist.core.audio.AudioRecorder
import com.yasha.assist.core.audio.RecorderPhase
import com.yasha.assist.core.audio.VadRecorderController
import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.ChatAttachments
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.yasha.assist.core.capture.AttachmentEncoder
import com.yasha.assist.core.markdown.YashaMarkdown
import com.yasha.assist.core.net.ChatEvent
import com.yasha.assist.core.net.chatRequestBody
import com.yasha.assist.core.net.YashaClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import com.yasha.assist.core.capture.RectFrac
import com.yasha.assist.core.design.GeminiBlue
import com.yasha.assist.core.design.GeminiBlueSoft
import com.yasha.assist.core.net.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.min

class FloatyActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(com.yasha.assist.core.net.AppLocale.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!SessionStore(this).signedIn()) {
            // No session yet: the login flow must come first.
            startActivity(Intent().setClassName(this, PendingAskStore.mainActivityComponent()))
            finish()
            return
        }
        // Immersive like the chat: the frozen shot draws BEHIND the system bars
        // (theme = Theme.Yasha.Floaty: opaque window, transparent bars — NOT a
        // translucent window, which OEMs force-paint black behind the bars).
        // Bar-icon contrast is refined from the shot once it loads (BarTone).
        enableEdgeToEdge()
        val dark = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        setContent {
            com.yasha.assist.core.design.YashaTheme { FloatyScreen(onDismiss = { finish() }) }
        }
    }
}

private sealed interface Selection {
    data object None : Selection
    data class Region(val rect: RectFrac) : Selection
}

@Composable
fun FloatyScreen(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var background by remember { mutableStateOf<Background?>(null) }
    var input by remember { mutableStateOf("") }
    var selection by remember { mutableStateOf<Selection>(Selection.None) }
    var encoding by remember { mutableStateOf(false) }
    var encodeError by remember { mutableStateOf<String?>(null) }
    var pickedUrl by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    val client = remember { YashaClient(SessionStore(context)) }
    var answer by remember { mutableStateOf<String?>(null) }
    var askTools by remember { mutableStateOf<List<AskTool>>(emptyList()) }
    var answerError by remember { mutableStateOf<String?>(null) }
    var askThreadId by remember { mutableStateOf<String?>(null) }
    var askJob by remember { mutableStateOf<Job?>(null) }
    var sentUrls by remember { mutableStateOf<List<String>>(emptyList()) }
    var sentText by remember { mutableStateOf("") }
    var streaming by remember { mutableStateOf(false) }

    // Auto-listen: VAD auto-stop recording (AUDIO-REFACTO-PLAN §8). Drawing
    // the region never stops the mic; a usable take auto-sends with the crop.
    val listen = remember { ListenStateMachine() }
    // Late-bound: send() is defined below with the composer state.
    var sendWithAudio: (String) -> Unit = {}
    val recorder = remember {
        VadRecorderController(
            scope = scope,
            recorderFactory = { level -> AudioRecorder(levelListener = level) },
            onAudioReady = { wav ->
                if (listen.shouldAutoSend()) {
                    val dataUrl = "data:audio/wav;base64," + java.util.Base64.getEncoder().encodeToString(wav)
                    sendWithAudio(dataUrl)
                }
            },
        )
    }
    val recorderState by recorder.state.collectAsState()
    val listening = recorderState.phase == RecorderPhase.RECORDING
    val micPermission = android.Manifest.permission.RECORD_AUDIO
    val micToast = stringResource(R.string.floaty_mic_error)
    val tooShortToast = stringResource(R.string.floaty_mic_too_short)
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) recorder.start()
        else android.widget.Toast.makeText(context, micToast, android.widget.Toast.LENGTH_SHORT).show()
    }
    fun micGranted() = androidx.core.content.ContextCompat.checkSelfPermission(context, micPermission) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
    fun onMicTap() {
        if (recorder.state.value.phase == RecorderPhase.RECORDING) recorder.stop()
        else if (micGranted()) recorder.start()
        else micLauncher.launch(micPermission)
    }

    val decorView = androidx.compose.ui.platform.LocalView.current
    LaunchedEffect(Unit) {
        var shotInsets = androidx.core.view.ViewCompat.getRootWindowInsets(decorView)
        if (shotInsets == null) { delay(300); shotInsets = androidx.core.view.ViewCompat.getRootWindowInsets(decorView) }
        val bg = withContext(Dispatchers.IO) {
            var result = CaptureOrchestrator.grab()
            if (result is Background.Shot && shotInsets != null) {
                val b = result.bitmap
                val viewH = decorView.height
                val scale = if (viewH > 0) b.height.toFloat() / viewH else 1f
                val fixed = ShotFrame.repair(
                    b,
                    (shotInsets.getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top * scale).toInt(),
                    (shotInsets.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars()).bottom * scale).toInt(),
                )
                if (fixed !== b) result = Background.Shot(fixed)
            }
            result
        }
        background = bg
        // Bar-icon contrast follows the shot (it IS the screen under the bars).
        if (bg is Background.Shot) {
            val win = (context as? android.app.Activity)?.window
            val (lightTop, lightNav) = withContext(Dispatchers.Default) {
                BarTone.isLight(BarTone.sample(bg.bitmap, fromTop = true)) to
                    BarTone.isLight(BarTone.sample(bg.bitmap, fromTop = false))
            }
            if (win != null) {
                androidx.core.view.WindowInsetsControllerCompat(win, win.decorView).apply {
                    isAppearanceLightStatusBars = lightTop
                    isAppearanceLightNavigationBars = lightNav
                }
            }
        }
    }

    // Issue #69: the assistant intent — opening the floaty is the strongest
    // "about to ask" signal. Fire-and-forget warm with the model omitted (the
    // catalog isn't loaded here; the server resolves fast → smart). The
    // server's 60 s prefix-hash dedupe collapses it with the app-open warm.
    LaunchedEffect(Unit) { client.warmBackend(null) }

    LaunchedEffect(Unit) {
        when (val r = client.audioConfig()) {
            is ApiResult.Ok -> recorder.setEnabled(r.value.enabled)
            is ApiResult.Err -> recorder.setEnabled(false)
        }
        if (listen.onShown(recorder.state.value.enabled, micGranted())) recorder.start()
    }

    LaunchedEffect(recorderState.error) {
        when (recorderState.error) {
            "mic" -> android.widget.Toast.makeText(context, micToast, android.widget.Toast.LENGTH_SHORT).show()
            "too_short" -> android.widget.Toast.makeText(context, tooShortToast, android.widget.Toast.LENGTH_SHORT).show()
        }
        if (recorderState.error != null) recorder.clearError()
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            picking = true
            scope.launch {
                val res = withContext(Dispatchers.IO) {
                    runCatching {
                        context.contentResolver.openInputStream(uri)?.use { stream ->
                            BitmapFactory.decodeStream(stream)?.let { AttachmentEncoder.encodeBitmap(it, asPng = false) }
                        }
                    }.getOrNull()
                }
                picking = false
                when (res) {
                    is AttachmentEncoder.Result.Ok -> pickedUrl = res.dataUrl
                    is AttachmentEncoder.Result.Err -> encodeError = res.code
                    null -> encodeError = "unsupported"
                }
            }
        }
    }

    fun openInYasha() {
        val intent = Intent().setClassName(context, PendingAskStore.mainActivityComponent())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val id = askThreadId
        if (id != null) {
            intent.putExtra("com.yasha.assist.extra.THREAD", id)
        } else {
            // Ask never got a thread id (failed/network): hand the draft over instead.
            PendingAskStore.put(PendingAskStore.Pending(sentText, sentUrls))
            intent.putExtra("com.yasha.assist.extra.ASSIST", System.currentTimeMillis())
        }
        context.startActivity(intent)
        onDismiss()
    }

    fun send(audioUrl: String? = null) {
        val text = input.trim()
        val rect = (selection as? Selection.Region)?.rect
        val picked = pickedUrl
        if (encoding || (text.isEmpty() && picked == null && audioUrl == null)) return
        encoding = true
        // Follow-ups continue on the same thread; the previous answer disappears on send.
        val threadId = if (answer != null) askThreadId else null
        scope.launch {
            val urls = withContext(Dispatchers.Default) {
                // No selection → the whole frozen screenshot is attached.
                val base = if (answer == null) {
                    (background as? Background.Shot)?.bitmap?.let {
                        AttachmentEncoder.encodeCrop(it, rect ?: RectFrac(0f, 0f, 1f, 1f))
                    }
                } else {
                    null
                }
                when (base) {
                    is AttachmentEncoder.Result.Err -> return@withContext listOf(base.code)
                    is AttachmentEncoder.Result.Ok -> listOfNotNull(base.dataUrl, picked)
                    null -> listOfNotNull(picked)
                }
            }
            encoding = false
            if (urls.size == 1 && (urls[0] == "unsupported" || urls[0] == "too_large")) {
                encodeError = urls[0]
                return@launch
            }
            sentText = text
            sentUrls = urls
            selection = Selection.None
            pickedUrl = null
            input = ""
            askThreadId = threadId
            answerError = null
            answer = ""
            askTools = emptyList()
            streaming = true
            askJob = scope.launch {
                // Coalesce SSE deltas (flush every 150ms) — per-token state writes
                // recompose the full-screen frozen-shot overlay and ANR older devices.
                val buf = StringBuilder()
                fun flush() {
                    if (buf.isNotEmpty()) {
                        answer = (answer ?: "") + buf.toString()
                        buf.setLength(0)
                    }
                }
                try {
                    launch { while (isActive) { delay(150); flush() } }
                    client.chatStream(
                        chatRequestBody(
                            text = text,
                            threadId = threadId,
                            attachments = if (urls.isEmpty() && audioUrl == null) {
                                null
                            } else {
                                ChatAttachments(images = urls.ifEmpty { null }, audio = audioUrl)
                            },
                        ),
                    ).collect { ev ->
                        when (ev) {
                            is ChatEvent.ThreadId -> askThreadId = ev.id
                            is ChatEvent.Delta -> buf.append(ev.text)
                            is ChatEvent.ToolProgress -> askTools = askTools.upsertTool(ev.server, ev.name, ev.status, ev.truncated)
                            is ChatEvent.RenderCard -> {} // floaty has no card renderer (cards stay off in its body)
                            is ChatEvent.Failure -> answerError = ev.code
                            is ChatEvent.Done -> {}
                        }
                    }
                } finally {
                    flush()
                    streaming = false
                }
            }
        }
    }

    sendWithAudio = { url -> send(audioUrl = url) }

    // Full-bleed frozen screenshot; the composer floats OVER it (Gemini-style),
    // so the screen reads as "no screenshot was taken". No global touch cutoff
    // anymore (AUDIO-REFACTO-PLAN §8): recording survives region drawing.
    Box(
        Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        when (val bg = background) {
            null -> Box(Modifier.fillMaxSize().background(Color(0xCC000000)), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            is Background.Shot -> {
                Image(
                    bitmap = bg.bitmap.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
            }
            Background.Protected, Background.NoSource -> {
                Box(Modifier.fillMaxSize().background(Color(0xF209090A)), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            stringResource(if (bg == Background.Protected) R.string.floaty_protected else R.string.floaty_no_capture),
                            color = Color.White,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(horizontal = 32.dp),
                        )
                        if (bg == Background.NoSource) {
                            TextButton(onClick = {
                                runCatching { context.startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
                            }) { Text(stringResource(R.string.floaty_open_accessibility), color = GeminiBlueSoft) }
                        }
                    }
                }
            }
        }

        if (background is Background.Shot) {
            AuroraOverlay(Modifier.fillMaxSize())
        }

        if (background is Background.Shot && answer == null) {
            // Gemini-style: colored aurora waves hugging the selection border.
            (selection as? Selection.Region)?.let { SelectionGlow(it.rect, Modifier.fillMaxSize()) }
            SelectionLayer(
                selection = selection,
                enabled = true,
                onRegion = { rect -> selection = Selection.Region(rect) },
            )
        }

        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                // Gradient bleeds behind the transparent nav bar; content stays above it.
                .background(Brush.verticalGradient(0f to Color.Transparent, 0.65f to Color(0x99000000)))
                .navigationBarsPadding(),
        ) {
            val loading = streaming && answer.isNullOrEmpty()
            encodeError?.let {
                Text(
                    stringResource(if (it == "too_large") R.string.floaty_crop_too_large else R.string.floaty_crop_failed),
                    color = Color(0xFFFF8A80),
                    modifier = Modifier.padding(horizontal = 24.dp),
                )
            }
            val region = selection as? Selection.Region
            if (region != null && answer == null) {
                Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.floaty_selection_ready), style = MaterialTheme.typography.bodySmall, color = GeminiBlueSoft)
                    Spacer(Modifier.size(8.dp))
                    IconButton(onClick = { selection = Selection.None }) {
                        Icon(Icons.Default.Close, stringResource(R.string.floaty_clear_selection), tint = Color.White)
                    }
                }
            }
            if (pickedUrl != null) {
                Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.floaty_picked_image), style = MaterialTheme.typography.bodySmall, color = GeminiBlueSoft)
                    Spacer(Modifier.size(8.dp))
                    IconButton(onClick = { pickedUrl = null }) {
                        Icon(Icons.Default.Close, stringResource(R.string.floaty_remove_image), tint = Color.White)
                    }
                }
            }

            answer?.takeIf { it.isNotEmpty() || answerError != null }?.let { text ->
                AnswerCard(
                    answer = text,
                    streaming = streaming,
                    error = answerError,
                    tools = askTools,
                    onOpen = ::openInYasha,
                )
            }

            if (loading) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp)
                        .height(58.dp)
                        .clip(RoundedCornerShape(29.dp))
                        .background(Color(0xF2131314)),
                ) {
                    AuroraOverlay(Modifier.matchParentSize(), pill = true)
                    Row(
                        Modifier.fillMaxSize().padding(horizontal = 20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.floaty_loading),
                            color = Color.White,
                            modifier = Modifier.weight(1f),
                        )
                        FilledIconButton(
                            onClick = { askJob?.cancel() },
                            shape = CircleShape,
                            colors = IconButtonDefaults.filledIconButtonColors(containerColor = GeminiBlue),
                        ) {
                            Box(Modifier.size(14.dp).background(Color.White, RoundedCornerShape(3.dp)))
                        }
                    }
                }
            } else {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilledIconButton(
                        onClick = { runCatching { photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } },
                        shape = CircleShape,
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = Color(0xF21E1E20)),
                    ) {
                        if (picking) CircularProgressIndicator(Modifier.size(18.dp))
                        else Icon(Icons.Default.Add, stringResource(R.string.floaty_attach_image), tint = Color.White)
                    }
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.weight(1f),
                        placeholder = {
                            Text(
                                stringResource(if (listening) R.string.floaty_listening else R.string.floaty_hint),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        shape = RoundedCornerShape(28.dp),
                        maxLines = 3,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = Color(0xF21E1E20),
                            unfocusedContainerColor = Color(0xF21E1E20),
                        ),
                    )
                    if (recorderState.enabled) {
                        FilledIconButton(
                            onClick = ::onMicTap,
                            shape = CircleShape,
                            colors = IconButtonDefaults.filledIconButtonColors(
                                containerColor = if (listening) Color(0xFFD93025) else Color(0xF21E1E20),
                            ),
                        ) {
                            if (listening) Box(Modifier.size(14.dp).background(Color.White, RoundedCornerShape(3.dp)))
                            else Icon(painterResource(R.drawable.ic_mic), stringResource(R.string.floaty_mic), tint = Color.White)
                        }
                    }
                    FilledIconButton(
                        onClick = ::send,
                        enabled = !encoding && (input.isNotBlank() || region != null || pickedUrl != null),
                        shape = CircleShape,
                    ) {
                        if (encoding) CircularProgressIndicator(Modifier.size(18.dp))
                        else Icon(Icons.Default.Send, stringResource(R.string.floaty_send))
                    }
                }
            }
        }
    }
}

// Separate composable so 150ms answer flushes don't recompose the full-screen
// screenshot image + selection canvas above it.
data class AskTool(val server: String, val name: String, val status: String, val truncated: Boolean = false)

internal fun List<AskTool>.upsertTool(server: String, name: String, status: String, truncated: Boolean = false): List<AskTool> {
    val tool = AskTool(server, name, status, truncated)
    val idx = indexOfLast { it.server == server && it.name == name }
    return if (idx >= 0) toMutableList().also { it[idx] = tool } else this + tool
}

@Composable
private fun AnswerCard(
    answer: String,
    streaming: Boolean,
    error: String?,
    tools: List<AskTool>,
    onOpen: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(Color(0xF20D1417)),
    ) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
            // Drag handle: swipe up to continue in the full-screen chat.
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(22.dp)
                    .pointerInput(Unit) {
                        var dy = 0f
                        detectVerticalDragGestures(
                            onDragEnd = { if (dy < -60f) onOpen() },
                            onDragCancel = {},
                            onVerticalDrag = { _, dragAmount -> dy += dragAmount },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.width(36.dp).height(4.dp).background(Color(0x55FFFFFF), CircleShape))
            }
            val scroll = rememberScrollState()
            LaunchedEffect(answer) { scroll.scrollTo(scroll.maxValue) }
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp, max = 340.dp)
                    .verticalScroll(scroll),
            ) {
                if (tools.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        tools.forEach { tool ->
                            // Amber warn state when the server cut the output (issue #8).
                            val warn = tool.truncated && tool.status != "error"
                            val label = when {
                                tool.status == "running" -> stringResource(R.string.tool_running)
                                tool.status == "error" -> stringResource(R.string.tool_error)
                                warn -> stringResource(R.string.tool_truncated)
                                else -> stringResource(R.string.tool_done)
                            }
                            val tint = when {
                                tool.status == "error" -> Color(0xFFFF8A80)
                                warn -> Color(0xFFFFB74D)
                                else -> Color(0xFF9AA7B0)
                            }
                            Row(
                                Modifier.clip(RoundedCornerShape(999.dp)).background(Color(0x22FFFFFF))
                                    .padding(horizontal = 10.dp, vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                if (tool.status == "running") {
                                    CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = tint)
                                }
                                Text("${tool.server} · ${tool.name} · $label", style = MaterialTheme.typography.labelSmall, color = tint)
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
                if (answer.isEmpty() && streaming) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = GeminiBlueSoft)
                } else {
                    YashaMarkdown(content = answer, streaming = streaming, dark = true)
                }
                error?.let {
                    Text(stringResource(R.string.floaty_ask_failed), color = Color(0xFFFF8A80))
                }
            }
        }
    }
}

// Stroke → bbox with 8 draggable handles, all in normalized (0..1) coordinates so
// canvas px and bitmap px stay decoupled.
@Composable
private fun SelectionLayer(
    selection: Selection,
    enabled: Boolean,
    onRegion: (RectFrac) -> Unit,
) {
    val density = LocalDensity.current
    val handleRadiusPx = with(density) { 14.dp.toPx() }
    val currentSelection by rememberUpdatedState(selection)
    var stroke by remember { mutableStateOf<List<Offset>>(emptyList()) }

    androidx.compose.foundation.Canvas(
        Modifier
            .fillMaxSize()
            .pointerInput(enabled, handleRadiusPx) {
                val canvasSize = Offset(size.width.toFloat(), size.height.toFloat())
                awaitEachGesture {
                    // MUST suspend before any early-exit: awaitEachGesture restarts the
                    // block without suspending, so an early `return` while disabled is a
                    // main-thread busy-loop (ANR on any touch).
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (!enabled) return@awaitEachGesture
                    val region = (currentSelection as? Selection.Region)?.rect
                    val handle = region?.let { hitHandle(it, down.position, canvasSize, handleRadiusPx) }
                    var dragHandle: Int? = handle
                    var localStroke = if (handle == null) listOf(down.position) else emptyList()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.pressed } ?: break
                        val p = Offset(
                            change.position.x.coerceIn(0f, canvasSize.x),
                            change.position.y.coerceIn(0f, canvasSize.y),
                        )
                        val h = dragHandle
                        if (h != null) {
                            (currentSelection as? Selection.Region)?.rect?.let {
                                onRegion(applyDrag(h, it, p, canvasSize))
                            }
                        } else {
                            localStroke += p
                            stroke = localStroke
                        }
                        change.consume()
                    }
                    if (dragHandle == null) {
                        val pts = localStroke.map { it.x / canvasSize.x to it.y / canvasSize.y }
                        val box = if (localStroke.size >= 8) SelectionGeometry.boundsFromStroke(pts, 1, 1) else null
                        stroke = emptyList()
                        if (box != null) onRegion(box)
                    }
                }
            },
    ) {
        val rect = (selection as? Selection.Region)?.rect
        if (rect != null) {
            val l = rect.left * size.width
            val t = rect.top * size.height
            val r = rect.right * size.width
            val b = rect.bottom * size.height
            drawRect(Color(0x99000000), Offset.Zero, Size(l, size.height))
            drawRect(Color(0x99000000), Offset(r, 0f), Size(size.width - r, size.height))
            drawRect(Color(0x99000000), Offset(l, 0f), Size(r - l, t))
            drawRect(Color(0x99000000), Offset(l, b), Size(r - l, size.height - b))
            val corner = min(28f, min((r - l) / 3f, (b - t) / 3f))
            drawCornerBrackets(l, t, r, b, corner)
        }
        if (stroke.size > 1) drawStroke(stroke)
    }
}

private fun DrawScope.drawStroke(points: List<Offset>) {
    val path = Path().apply {
        moveTo(points.first().x, points.first().y)
        points.drop(1).forEach { lineTo(it.x, it.y) }
        close()
    }
    drawPath(path, GeminiBlue.copy(alpha = 0.55f), style = Fill)
    drawPath(path, GeminiBlueSoft, style = Stroke(width = 6f, cap = StrokeCap.Round))
}

// Gemini-style crop handles: white rounded brackets on the 4 corners only; the
// 8 edge/corner hit targets stay invisible so every side remains draggable.
private fun DrawScope.drawCornerBrackets(l: Float, t: Float, r: Float, b: Float, corner: Float) {
    val arm = min(min(r - l, b - t) * 0.25f, 84f)
    val white = Color.White
    val style = Stroke(width = 8f, cap = StrokeCap.Round)
    val arcSize = Size(corner * 2f, corner * 2f)
    drawArc(white, 180f, 90f, false, Offset(l, t), arcSize, style = style)
    drawArc(white, 270f, 90f, false, Offset(r - corner * 2f, t), arcSize, style = style)
    drawArc(white, 0f, 90f, false, Offset(r - corner * 2f, b - corner * 2f), arcSize, style = style)
    drawArc(white, 90f, 90f, false, Offset(l, b - corner * 2f), arcSize, style = style)
    drawLine(white, Offset(l + corner + arm, t), Offset(l + corner, t), 8f, StrokeCap.Round)
    drawLine(white, Offset(r - corner - arm, t), Offset(r - corner, t), 8f, StrokeCap.Round)
    drawLine(white, Offset(l + corner + arm, b), Offset(l + corner, b), 8f, StrokeCap.Round)
    drawLine(white, Offset(r - corner - arm, b), Offset(r - corner, b), 8f, StrokeCap.Round)
    drawLine(white, Offset(l, t + corner + arm), Offset(l, t + corner), 8f, StrokeCap.Round)
    drawLine(white, Offset(l, b - corner - arm), Offset(l, b - corner), 8f, StrokeCap.Round)
    drawLine(white, Offset(r, t + corner + arm), Offset(r, t + corner), 8f, StrokeCap.Round)
    drawLine(white, Offset(r, b - corner - arm), Offset(r, b - corner), 8f, StrokeCap.Round)
}

private fun handlePoints(rect: RectFrac, size: Offset): List<Offset> {
    val l = rect.left * size.x
    val t = rect.top * size.y
    val r = rect.right * size.x
    val b = rect.bottom * size.y
    val cx = (l + r) / 2
    val cy = (t + b) / 2
    return listOf(
        Offset(l, t), Offset(cx, t), Offset(r, t),
        Offset(l, cy), Offset(r, cy),
        Offset(l, b), Offset(cx, b), Offset(r, b),
    )
}

private fun hitHandle(rect: RectFrac, p: Offset, size: Offset, radius: Float): Int? {
    handlePoints(rect, size).forEachIndexed { i, h ->
        if (abs(p.x - h.x) <= radius * 2 && abs(p.y - h.y) <= radius * 2) return i
    }
    return null
}

private fun applyDrag(handle: Int, rect: RectFrac, p: Offset, size: Offset): RectFrac {
    val x = p.x / size.x
    val y = p.y / size.y
    return when (handle) {
        0 -> rect.withEdges(l = x, t = y)
        1 -> rect.withEdges(t = y)
        2 -> rect.withEdges(r = x, t = y)
        3 -> rect.withEdges(l = x)
        4 -> rect.withEdges(r = x)
        5 -> rect.withEdges(l = x, b = y)
        6 -> rect.withEdges(b = y)
        else -> rect.withEdges(r = x, b = y)
    }
}

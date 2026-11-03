package com.yasha.assist.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.yasha.assist.core.audio.AudioRecorder
import com.yasha.assist.core.audio.MicRecorder
import com.yasha.assist.core.audio.RecorderPhase
import com.yasha.assist.core.audio.VadRecorderController
import com.yasha.assist.core.capture.AttachmentEncoder
import com.yasha.assist.core.net.ChatAttachments
import com.yasha.assist.core.net.ChatEvent
import com.yasha.assist.core.net.chatRequestBody
import com.yasha.assist.core.net.GenUiParser
import com.yasha.assist.core.net.ModelDto
import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.CardDto
import com.yasha.assist.core.net.SessionAccess
import com.yasha.assist.core.net.SessionProbe
import com.yasha.assist.core.net.UpdateMeta
import com.yasha.assist.core.net.YashaChatApi
import com.yasha.assist.core.net.ThreadRowDto
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class UiTool(
    val server: String,
    val name: String,
    val status: String, // "running" | "done" | "error"
    // Full call detail (openable tool card); null until the server provides it.
    val args: String? = null,
    val result: String? = null,
    // Server-side output truncation (issue #8) → amber warn chip.
    val truncated: Boolean = false,
    // Generative UI (issue #16): structured card rendered under the chip.
    val card: CardDto? = null,
)

data class UiMessage(
    val id: String,
    val role: String, // "user" | "assistant"
    val text: String,
    val images: List<String> = emptyList(),
    val tools: List<UiTool> = emptyList(),
    // Ordered text/tool interleaving of an assistant turn (issue #7). Empty =
    // fall back to "chips above the text" (legacy rows without meta.parts).
    val segments: List<UiSegment> = emptyList(),
    val streaming: Boolean = false,
    // Voice messages (AUDIO-REFACTO-PLAN): data URL + background caption.
    val audio: String? = null,
    val audioTranscript: String? = null,
    val audioTranscriptFailed: Boolean = false,
    // Failure annotation persisted by the server (meta.error, e.g. "timeout")
    // — renders the red "LLM timed out, retry?" notice under the message.
    val turnError: String? = null,
)

data class ChatUiState(
    val signedIn: Boolean = false,
    val checkingSession: Boolean = false,
    // Server unreachable while a stored session exists (issue #14): the app
    // shell stays visible with a banner; never means "signed out".
    val offline: Boolean = false,
    val baseUrl: String = "",
    val email: String = "",
    val busy: Boolean = false,
    val error: String? = null, // error code, mapped to a string resource in the UI
    val threads: List<ThreadRowDto> = emptyList(),
    val threadId: String? = null,
    val draft: Boolean = false, // composer open for a not-yet-created thread
    val threadTitle: String? = null,
    val messages: List<UiMessage> = emptyList(),
    val input: String = "",
    val attachments: List<String> = emptyList(), // data URLs
    val models: List<ModelDto> = emptyList(),
    val defaultModel: String? = null,
    val noVision: Boolean = false, // no configured model carries the vision tag
    val pickedModel: String? = null, // explicit override for the next send
    val audioEnabled: Boolean = false, // fast model is audio-capable
    val audioSmartModel: String? = null, // hide the mic while this model is picked
    val listening: Boolean = false,
    val listenSeconds: Int = 0,
    val micError: String? = null, // "mic" | "too_short" | "too_large", mapped in the UI
    // Server-side caps fetched on refresh (issue #15 parity with the web
    // composer); the MAX_* constants are only the pre-fetch fallback.
    val maxAttachments: Int = MAX_ATTACHMENTS,
    // Update channel (issue #34, Phase A): non-null ⇒ a newer build exists and
    // was not dismissed; updateCheckResult is the inline manual-check outcome
    // ("up_to_date" | version name | "error:<code>").
    val installedVersionName: String = "",
    val installedVersionCode: Int = 0,
    val updateVersionName: String? = null,
    val updateCheckResult: String? = null,
    // Phase B: non-null while the in-app update flow runs (build → download →
    // install); drives the dialog/banner body + buttons.
    val updateFlow: UpdateFlow? = null,
    // Phase C: CHANGELOG excerpt for the offered version (dialog body).
    val updateNotes: String? = null,
    // Phase C: Wi-Fi auto-download preference (mirrors SessionStore).
    val autoDownloadWifi: Boolean = false,
    // Phase C: non-zero ⇒ a notification asked to open the update dialog
    // (consumed by the UI as a LaunchedEffect key).
    val openUpdateTick: Long = 0L,

) {
    companion object {
        const val MAX_ATTACHMENTS = 4 // chat.maxImagesPerMessage default
        const val MAX_UPLOAD_BYTES = 20L * 1024 * 1024 // chat.maxUploadBytes default
    }
}

class ChatViewModel(
    private val store: SessionAccess,
    private val client: YashaChatApi,
    // Update channel (issue #34): the app's own stamp, injected so JVM tests
    // control the comparison; MainActivity passes BuildConfig.
    private val installedVersionCode: Int = 1,
    private val installedVersionName: String = "",
    // Phase B seams (issue #34): null in JVM tests / Phase-A-only callers —
    // then the Update dialog keeps the web re-download guidance.
    private val apkGateway: ApkInstallGateway? = null,
    private val apkFile: java.io.File? = null,
    private val recorderFactory: (onLevel: (rms: Double) -> Unit) -> MicRecorder =
        { level -> AudioRecorder(levelListener = level) },
    // Reconnect cadence while offline; a fake suspension hook in tests.
    private val reconnectDelay: suspend () -> Unit = { delay(10_000) },
    testScope: CoroutineScope? = null,
) : ViewModel() {
    // Settings VM pattern: tests inject an explicit scope so viewModelScope
    // (Main dispatcher) is never touched on the JVM.
    private val scope: CoroutineScope = testScope ?: viewModelScope
    private val _state = MutableStateFlow(
        ChatUiState(installedVersionName = installedVersionName, installedVersionCode = installedVersionCode),
    )
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private var streamJob: Job? = null
    private var reconnectJob: Job? = null
    private var msgSeq = 0
    private fun nextId() = "local-${msgSeq++}"

    fun start() {
        _state.update {
            it.copy(baseUrl = store.baseUrl, email = store.email.orEmpty(), autoDownloadWifi = store.autoDownloadWifi)
        }
        if (!store.signedIn()) return
        _state.update { it.copy(checkingSession = true) }
        scope.launch { probeAndEnter() }
    }

    // Issue #14: a transport failure is NOT a sign-out signal. Only the
    // server-confirmed `Invalid` clears the token (unrecoverable for
    // credential-seeded APKs when done on airplane mode); `Unreachable`
    // keeps the session, shows the offline banner and retries in background.
    private suspend fun probeAndEnter() {
        when (client.probeSession()) {
            SessionProbe.Valid -> {
                _state.update { it.copy(checkingSession = false, signedIn = true, offline = false, error = null) }
                refresh()
            }
            SessionProbe.Invalid -> {
                store.clearSession()
                _state.update { it.copy(checkingSession = false, signedIn = false, offline = false) }
            }
            SessionProbe.Unreachable -> {
                _state.update { it.copy(checkingSession = false, signedIn = true, offline = true) }
                scheduleReconnect()
            }
        }
    }

    // One background probe per reconnectDelay while the offline banner is up;
    // exits as soon as the server answers (Valid clears `offline`, Invalid
    // ends the session — both stop the loop).
    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            while (_state.value.offline) {
                reconnectDelay()
                if (_state.value.offline) probeAndEnter()
            }
        }
    }

    /** Banner Retry button: re-probe now (also used on resume). */
    fun retryNow() {
        if (!store.signedIn()) {
            start()
        } else if (_state.value.offline) {
            reconnectJob?.cancel()
            scope.launch { probeAndEnter() }
        } else {
            refresh()
        }
    }

    /** Activity resume: recover immediately when coming back with connectivity. */
    fun onResume() {
        if (_state.value.offline) retryNow()
    }

    fun signIn(baseUrl: String, email: String, password: String) {
        val url = baseUrl.trim().trimEnd('/')
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            _state.update { it.copy(error = "invalid_url") }
            return
        }
        store.baseUrl = url
        _state.update { it.copy(baseUrl = url, busy = true, error = null) }
        scope.launch {
            when (val r = client.signIn(email.trim(), password)) {
                is ApiResult.Err -> _state.update { it.copy(busy = false, error = r.code) }
                is ApiResult.Ok -> {
                    _state.update { it.copy(busy = false, signedIn = true, email = email.trim()) }
                    refresh()
                }
            }
        }
    }

    fun signOut() {
        streamJob?.cancel()
        scope.launch {
            client.signOut()
            streamJob = null
            _state.update { ChatUiState(baseUrl = store.baseUrl) }
        }
    }

    fun dismissError() = _state.update { it.copy(error = null) }

    fun refresh() {
        scope.launch {
            when (val r = client.fetchModels()) {
                is ApiResult.Ok -> _state.update { it.copy(models = r.value.models, defaultModel = r.value.default, noVision = r.value.noVision) }
                is ApiResult.Err -> _state.update { it.copy(error = r.code) }
            }
            when (val r = client.listThreads()) {
                is ApiResult.Ok -> _state.update { it.copy(threads = r.value) }
                is ApiResult.Err -> if (r.code == "unauthorized") forceSignedOut() else _state.update { it.copy(error = r.code) }
            }
            when (val r = client.audioConfig()) {
                is ApiResult.Ok -> {
                    audioMaxDataUrlBytes = r.value.maxAudioBytes
                    vadController.setEnabled(r.value.enabled)
                    _state.update {
                        it.copy(
                            audioEnabled = r.value.enabled,
                            audioSmartModel = r.value.smartModel,
                        )
                    }
                }
                is ApiResult.Err -> _state.update { it.copy(audioEnabled = false) }
            }
            // Admin-configured attachment caps; an error keeps the client defaults
            // (same posture as the web composer).
            when (val r = client.attachmentLimits()) {
                is ApiResult.Ok -> {
                    attachmentMaxFileBytes = r.value.maxUploadBytes
                    _state.update { it.copy(maxAttachments = r.value.maxImagesPerMessage.coerceAtLeast(0)) }
                }
                is ApiResult.Err -> Unit
            }
            // Update channel (issue #34): silent auto-check per entry, banner only.
            checkVersion(manual = false)
        }
    }

    // ---- Update channel (issue #34, Phase A) --------------------------------
    // "Newer" = server's build stamp above ours AND above the code the user
    // dismissed at least once (no re-nag until a strictly newer code appears).
    private var pendingUpdateCode: Int? = null

    private suspend fun checkVersion(manual: Boolean) {
        when (val r = client.fetchAppVersion()) {
            is ApiResult.Ok -> {
                val newer = r.value.versionCode > installedVersionCode
                if (manual) {
                    _state.update {
                        it.copy(updateCheckResult = if (newer) r.value.versionName else "up_to_date")
                    }
                }
                if (newer && r.value.versionCode > store.dismissedUpdateCode) {
                    pendingUpdateCode = r.value.versionCode
                    _state.update {
                        it.copy(updateVersionName = r.value.versionName, updateNotes = r.value.notes)
                    }
                } else {
                    _state.update { it.copy(updateNotes = null) }
                }
                // Nothing to install anymore → drop stale auto-download artifacts
                // (never while a flow is mid-flight on that very file).
                if (!newer && _state.value.updateFlow == null) {
                    apkFile?.parentFile?.let { UpdateMeta.clear(it) }
                }
            }
            // Public endpoint on the same host as every other call: a failure
            // here is connectivity, never "no update" — except the admin kill-
            // switch (Phase C), which must also take the banner down.
            is ApiResult.Err -> {
                if (manual) _state.update { it.copy(updateCheckResult = "error:${r.code}") }
                if (r.code == "app_updates_disabled") {
                    pendingUpdateCode = null
                    _state.update { it.copy(updateVersionName = null, updateNotes = null) }
                }
            }
        }
    }

    fun checkForUpdates() {
        scope.launch { checkVersion(manual = true) }
    }

    /** "Later": silence this exact code until the server publishes a newer one. */
    fun dismissUpdate() {
        pendingUpdateCode?.let { store.dismissedUpdateCode = it }
        pendingUpdateCode = null
        updateController?.cancel()
        _state.update { it.copy(updateVersionName = null) }
    }

    // ---- Update flow (issue #34, Phase B) -----------------------------------
    // Lazily assembled from the Phase-B seams; null without a gateway (tests).
    private val updateController: UpdateController? by lazy {
        val gateway = apkGateway ?: return@lazy null
        val file = apkFile ?: return@lazy null
        UpdateController(
            transport = ClientUpdateTransport(client),
            installer = gateway,
            scope = scope,
            apkFile = file,
            publish = { flow -> _state.update { it.copy(updateFlow = flow) } },
            onSuccess = {
                pendingUpdateCode = null
                // The installed package makes the cached APK + marker stale.
                apkFile?.parentFile?.let { UpdateMeta.clear(it) }
                _state.update { it.copy(updateFlow = null, updateVersionName = null) }
            },
        )
    }

    /** Settings toggle (issue #34 Phase C): background download over Wi-Fi. */
    fun setAutoDownloadWifi(enabled: Boolean) {
        store.autoDownloadWifi = enabled
        _state.update { it.copy(autoDownloadWifi = enabled) }
    }

    /**
     * A periodic-check notification was tapped. `ready` = the auto-download
     * already left a verified APK on disk → offer it straight to the installer
     * (when it still matches the marker); otherwise show the dialog and make
     * sure the banner data is fresh.
     */
    fun onUpdateNotification(ready: Boolean) {
        _state.update { it.copy(openUpdateTick = System.currentTimeMillis()) }
        val controller = updateController
        if (ready && apkFile != null && controller != null) {
            val dir = apkFile.parentFile ?: return
            val meta = UpdateMeta.read(dir)
            if (meta != null && meta.versionCode > installedVersionCode) {
                controller.primeFromVerifiedFile(meta.sha256)
                return
            }
        }
        if (ready) {
            startUpdate()
        } else if (_state.value.updateVersionName == null && _state.value.updateFlow == null) {
            scope.launch { checkVersion(manual = false) }
        }
    }

    /** Dialog "Update": ask the server to build our update, then follow it. */
    fun startUpdate() {
        updateController?.start()
    }

    /** Dialog "Install" / auto after permission grant / on resume. */
    fun launchUpdateInstall() {
        updateController?.launch()
    }

    /** MainActivity ON_RESUME: re-check the install permission or retry a
     * commit that had to wait for the app to come back to the foreground. */
    fun resumeUpdateFlow() {
        updateController?.onResume()
    }

    fun openInstallPermissionSettings() {
        apkGateway?.openPermissionSettings()
    }

    fun cancelUpdate() {
        updateController?.cancel()
    }

    // ---- Voice input (AUDIO-REFACTO-PLAN §8): VAD auto-stop recording, the
    // finished WAV rides the chat request as input_audio (no transcription
    // hop). Captions arrive later from the background caption job.
    private var audioMaxDataUrlBytes = 8_388_608L
    private var attachmentMaxFileBytes = ChatUiState.MAX_UPLOAD_BYTES
    private var lastSendHadAudio = false
    private var captionJob: Job? = null

    private val vadController = VadRecorderController(
        scope = scope,
        recorderFactory = recorderFactory,
        onAudioReady = { wav ->
            val dataUrl = "data:audio/wav;base64," + Base64.getEncoder().encodeToString(wav)
            scope.launch {
                val s = _state.value
                sendInternal(s.input.trim(), s.attachments, dataUrl)
            }
        },
        maxWavBytes = { ((audioMaxDataUrlBytes - 64) * 3) / 4 },
    )

    init {
        scope.launch {
            vadController.state.collect { sp ->
                _state.update {
                    it.copy(
                        listening = sp.phase == RecorderPhase.RECORDING,
                        listenSeconds = sp.seconds,
                        micError = sp.error,
                    )
                }
            }
        }
    }

    fun startListening() = vadController.start()
    fun stopListening() = vadController.stop()
    fun cancelListening() = vadController.cancel()
    fun clearMicError() = vadController.clearError()

    /** Caption retry (failed caption): re-enqueue the job, poll for the outcome. */
    fun retryTranscribe(messageId: String) {
        scope.launch {
            when (val r = client.retryTranscribe(messageId)) {
                is ApiResult.Err -> _state.update { it.copy(error = r.code) }
                is ApiResult.Ok -> {
                    _state.update { st ->
                        st.copy(messages = st.messages.map {
                            if (it.id == messageId) it.copy(audioTranscriptFailed = false) else it
                        })
                    }
                    _state.value.threadId?.let { pollCaptions(it) }
                }
            }
        }
    }

    /** Poll the thread while a voice caption is pending (bounded, 8 × 4 s —
     * mirrors the web chat-surface behavior). */
    private fun pollCaptions(threadId: String) {
        if (captionJob?.isActive == true) return
        captionJob = scope.launch {
            repeat(8) {
                delay(4000)
                val r = client.openThread(threadId)
                if (r !is ApiResult.Ok) return@launch
                var pending = false
                _state.update { st ->
                    val byId = r.value.messages.associateBy { it.id }
                    val msgs = st.messages.map { m ->
                        val src = byId[m.id]
                        if (m.audio != null && src != null) {
                            val transcript = src.meta?.audioTranscript
                            val failed = src.meta?.audioTranscriptFailed == true
                            if (transcript == null && !failed) pending = true
                            m.copy(audioTranscript = transcript, audioTranscriptFailed = failed)
                        } else m
                    }
                    st.copy(messages = msgs)
                }
                if (!pending) return@launch
            }
        }
    }

    fun openThread(id: String) {
        scope.launch {
            when (val r = client.openThread(id)) {
                is ApiResult.Ok -> _state.update { st ->
                    val threadPick = r.value.thread.model?.takeIf { tid -> st.models.any { it.id == tid } }
                    st.copy(
                        threadId = id,
                        draft = false,
                        threadTitle = r.value.thread.title,
                        pickedModel = threadPick,
                        error = null,
                        messages = r.value.messages.map { m ->
                            val uiTools = m.meta?.tools.orEmpty().map { t ->
                                UiTool(t.server, t.name, if (t.ok) "done" else "error", t.args, t.result, t.truncated, t.card)
                            }
                            // Stored generative cards (issue #30): re-validated
                            // on read; on a parts mismatch they append after the
                            // legacy chips+text rendering.
                            val uiCards = m.meta?.cards.orEmpty().mapNotNull { sc ->
                                GenUiParser.parseRoot(sc.root).takeIf { it.isNotEmpty() }?.let { UiSegment.Card(sc.id, it) }
                            }
                            val stored = TurnSegments.fromStored(m.meta?.parts, uiTools, uiCards)
                            val segments = stored ?: if (uiCards.isEmpty()) {
                                emptyList()
                            } else {
                                listOfNotNull(
                                    UiSegment.Tools(uiTools).takeIf { uiTools.isNotEmpty() },
                                    UiSegment.Text(m.content).takeIf { m.content.isNotEmpty() },
                                ) + uiCards
                            }
                            UiMessage(
                                id = m.id,
                                role = m.role,
                                text = m.content,
                                images = m.meta?.images.orEmpty(),
                                tools = uiTools,
                                segments = segments,
                                audio = m.meta?.audio,
                                audioTranscript = m.meta?.audioTranscript,
                                audioTranscriptFailed = m.meta?.audioTranscriptFailed == true,
                                turnError = m.meta?.error,
                            )
                        },
                    )
                }
                is ApiResult.Err -> _state.update { it.copy(error = r.code) }
            }
            // Re-attach the caption poller to a thread that still has pending
            // voice captions (e.g. app reopened while the job runs).
            val msgs = _state.value.messages
            if (msgs.any { it.audio != null && it.audioTranscript == null && !it.audioTranscriptFailed }) {
                pollCaptions(id)
            }
        }
    }

    fun newChat() {
        if (streamJob?.isActive == true) return
        _state.update { it.copy(draft = true, threadId = null, threadTitle = null, messages = emptyList(), pickedModel = null, error = null, input = "", attachments = emptyList()) }
    }

    fun showList() {
        if (streamJob?.isActive == true) return
        _state.update { it.copy(draft = false, threadId = null, threadTitle = null, messages = emptyList(), pickedModel = null, error = null, input = "", attachments = emptyList()) }
    }

    fun deleteThread(id: String) {
        scope.launch {
            client.deleteThread(id)
            if (_state.value.threadId == id) showList()
            refresh()
        }
    }

    fun pickModel(id: String?) = _state.update { it.copy(pickedModel = id) }

    /** Prefill a fresh chat from a floaty ask (crop already encoded as data URLs). */
    fun prefillAssist(text: String, dataUrls: List<String>) {
        val imgs = if (_state.value.noVision) {
            _state.update { it.copy(error = "no_vision_model") }
            emptyList()
        } else {
            dataUrls
        }
        _state.update {
            it.copy(
                input = text,
                attachments = (imgs + it.attachments).take(it.maxAttachments),
            )
        }
    }

    fun setInput(text: String) = _state.update { it.copy(input = text) }

    fun addAttachment(bytes: ByteArray, mime: String?) {
        if (_state.value.noVision) {
            _state.update { it.copy(error = "no_vision_model") }
            return
        }
        when (val r = AttachmentEncoder.encode(bytes, mime, attachmentMaxFileBytes)) {
            is AttachmentEncoder.Result.Err -> _state.update { it.copy(error = r.code) }
            is AttachmentEncoder.Result.Ok -> _state.update {
                if (it.attachments.size >= it.maxAttachments) it.copy(error = "attachment_too_many")
                else it.copy(attachments = it.attachments + r.dataUrl)
            }
        }
    }

    fun removeAttachment(index: Int) = _state.update { it.copy(attachments = it.attachments.filterIndexed { i, _ -> i != index }) }

    fun send() {
        val s = _state.value
        sendInternal(s.input.trim(), s.attachments, null)
    }

    /** Shared send path: typed text + selected images + optional audio data
     * URL (auto-sent by the mic on VAD stop, together with the text). */
    private fun sendInternal(text: String, images: List<String>, audioUrl: String?) {
        val s = _state.value
        if (s.busy) return
        if (text.isEmpty() && images.isEmpty() && audioUrl == null) return
        lastSendHadAudio = audioUrl != null
        val userMsg = UiMessage(nextId(), "user", text, images, audio = audioUrl)
        _state.update {
            it.copy(
                busy = true,
                error = null,
                input = "",
                attachments = emptyList(),
                messages = it.messages + userMsg + UiMessage(nextId(), "assistant", "", streaming = true),
            )
        }
        var sawThreadId = s.threadId != null
        var failed = false
        streamJob = scope.launch {
            client.chatStream(
                chatRequestBody(
                    text = text,
                    threadId = s.threadId,
                    model = s.pickedModel ?: s.defaultModel,
                    attachments = if (images.isEmpty() && audioUrl == null) {
                        null
                    } else {
                        ChatAttachments(images = images.ifEmpty { null }, audio = audioUrl)
                    },
                    // The chat screen renders render_ui cards (issue #30);
                    // asks stay off (no answer UI).
                    cards = true,
                ),
            ).collect { ev ->
                when (ev) {
                    is ChatEvent.ThreadId -> {
                        sawThreadId = true
                        _state.update { it.copy(threadId = ev.id) }
                    }
                    is ChatEvent.Delta -> _state.update {
                        val msgs = it.messages.toMutableList()
                        val last = msgs.last()
                        // Live ordering = SSE arrival order (issue #7): the
                        // text mirror drives copy/scroll, segments drive render.
                        msgs[msgs.lastIndex] = last.copy(
                            text = last.text + ev.text,
                            segments = TurnSegments.appendText(last.segments, ev.text),
                        )
                        it.copy(messages = msgs)
                    }
                    is ChatEvent.ToolProgress -> _state.update {
                        val msgs = it.messages.toMutableList()
                        val last = msgs.last()
                        val tool = UiTool(ev.server, ev.name, ev.status, ev.args, ev.result, ev.truncated, ev.card)
                        msgs[msgs.lastIndex] = last.copy(
                            segments = TurnSegments.applyTool(last.segments, tool),
                        )
                        it.copy(messages = msgs)
                    }
                    is ChatEvent.RenderCard -> _state.update {
                        val msgs = it.messages.toMutableList()
                        val last = msgs.last()
                        msgs[msgs.lastIndex] = last.copy(
                            segments = TurnSegments.appendCard(last.segments, UiSegment.Card(ev.id, ev.nodes)),
                        )
                        it.copy(messages = msgs)
                    }
                    is ChatEvent.Done -> finishGeneration(aborted = ev.aborted, sawThreadId = sawThreadId)
                    is ChatEvent.Failure -> {
                        failed = true
                        if (ev.code == "unauthorized") {
                            forceSignedOut()
                        } else if (sawThreadId) {
                            // Server kept the user message and annotated it with the
                            // error code — re-open the thread so the failure notice
                            // (and any partial answer) renders from server truth.
                            finishGeneration(aborted = false, sawThreadId = true, refetch = true)
                        } else {
                            _state.update { it.copy(error = ev.code) }
                            finishGeneration(aborted = false, sawThreadId = false)
                        }
                    }
                }
            }
            if (!failed && _state.value.busy) finishGeneration(aborted = true, sawThreadId = sawThreadId) // flow ended without terminal event
        }
    }

    fun stop() {
        streamJob?.cancel()
        streamJob = null
        val s = _state.value
        _state.update { it.copy(busy = false, messages = it.messages.filterNot { m -> m.streaming && m.text.isEmpty() }.map { m -> m.copy(streaming = false) }) }
        if (s.threadId != null) openThread(s.threadId) // server persisted the partial turn
    }

    private fun finishGeneration(aborted: Boolean, sawThreadId: Boolean, refetch: Boolean = false) {
        streamJob = null
        _state.update {
            val msgs = it.messages.toMutableList()
            if (msgs.isNotEmpty() && msgs.last().streaming) {
                val last = msgs.removeAt(msgs.lastIndex)
                // Keep a tool-only turn visible (its chips live in the DB too).
                if (last.text.isNotEmpty() || last.segments.isNotEmpty()) {
                    msgs.add(last.copy(streaming = false))
                }
            }
            it.copy(busy = false, messages = msgs)
        }
        if (sawThreadId) {
            val id = _state.value.threadId
            if (id != null) {
                if (aborted || refetch) openThread(id)
                if (lastSendHadAudio) pollCaptions(id)
            }
            refresh()
        } else {
            // request never started: drop the optimistic user message too
            _state.update { it.copy(messages = it.messages.filterNot { m -> m.role == "user" && m.id.startsWith("local-") }) }
        }
    }

    /** Retry a failed turn (red notice under the user message): drop the
     * stale row locally, the server replaces it as the trailing failed turn. */
    fun retryTurn(messageId: String) {
        val m = _state.value.messages.find { it.id == messageId } ?: return
        _state.update { it.copy(messages = it.messages.filterNot { x -> x.id == messageId }) }
        sendInternal(m.text, m.images, m.audio)
    }

    private fun forceSignedOut() {
        streamJob?.cancel()
        store.clearSession()
        _state.update { ChatUiState(baseUrl = store.baseUrl, error = "unauthorized") }
    }

    override fun onCleared() {
        // Never leak the AudioRecord across screen death (SPEECH-PLAN P3).
        cancelListening()
    }

    class Factory(
        private val store: SessionAccess,
        private val client: YashaChatApi,
        private val installedVersionCode: Int = 1,
        private val installedVersionName: String = "",
        private val apkGateway: ApkInstallGateway? = null,
        private val apkFile: java.io.File? = null,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
            ChatViewModel(store, client, installedVersionCode, installedVersionName, apkGateway, apkFile) as T
    }
}

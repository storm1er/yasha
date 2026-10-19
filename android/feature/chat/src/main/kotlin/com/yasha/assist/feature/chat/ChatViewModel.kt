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
import com.yasha.assist.core.net.ChatRequestBody
import com.yasha.assist.core.net.ModelDto
import com.yasha.assist.core.net.SessionStore
import com.yasha.assist.core.net.YashaClient
import com.yasha.assist.core.net.ApiResult
import com.yasha.assist.core.net.ThreadRowDto
import java.util.Base64
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
)

data class UiMessage(
    val id: String,
    val role: String, // "user" | "assistant"
    val text: String,
    val images: List<String> = emptyList(),
    val tools: List<UiTool> = emptyList(),
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

) {
    companion object {
        const val MAX_ATTACHMENTS = 4 // chat.maxImagesPerMessage default
    }
}

class ChatViewModel(
    private val store: SessionStore,
    private val client: YashaClient,
    private val recorderFactory: (onLevel: (rms: Double) -> Unit) -> MicRecorder =
        { level -> AudioRecorder(levelListener = level) },
) : ViewModel() {
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private var streamJob: Job? = null
    private var msgSeq = 0
    private fun nextId() = "local-${msgSeq++}"

    fun start() {
        _state.update { it.copy(baseUrl = store.baseUrl, email = store.email.orEmpty()) }
        if (!store.signedIn()) return
        _state.update { it.copy(checkingSession = true) }
        viewModelScope.launch {
            if (client.probeSession()) {
                _state.update { it.copy(checkingSession = false, signedIn = true) }
                refresh()
            } else {
                store.clearSession()
                _state.update { it.copy(checkingSession = false, signedIn = false) }
            }
        }
    }

    fun signIn(baseUrl: String, email: String, password: String) {
        val url = baseUrl.trim().trimEnd('/')
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            _state.update { it.copy(error = "invalid_url") }
            return
        }
        store.baseUrl = url
        _state.update { it.copy(baseUrl = url, busy = true, error = null) }
        viewModelScope.launch {
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
        viewModelScope.launch {
            client.signOut()
            streamJob = null
            _state.update { ChatUiState(baseUrl = store.baseUrl) }
        }
    }

    fun dismissError() = _state.update { it.copy(error = null) }

    fun refresh() {
        viewModelScope.launch {
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
        }
    }

    // ---- Voice input (AUDIO-REFACTO-PLAN §8): VAD auto-stop recording, the
    // finished WAV rides the chat request as input_audio (no transcription
    // hop). Captions arrive later from the background caption job.
    private var audioMaxDataUrlBytes = 8_388_608L
    private var lastSendHadAudio = false
    private var captionJob: Job? = null

    private val vadController = VadRecorderController(
        scope = viewModelScope,
        recorderFactory = recorderFactory,
        onAudioReady = { wav ->
            val dataUrl = "data:audio/wav;base64," + Base64.getEncoder().encodeToString(wav)
            viewModelScope.launch {
                val s = _state.value
                sendInternal(s.input.trim(), s.attachments, dataUrl)
            }
        },
        maxWavBytes = { ((audioMaxDataUrlBytes - 64) * 3) / 4 },
    )

    init {
        viewModelScope.launch {
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
        viewModelScope.launch {
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
        captionJob = viewModelScope.launch {
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
        viewModelScope.launch {
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
                            UiMessage(
                                id = m.id,
                                role = m.role,
                                text = m.content,
                                images = m.meta?.images.orEmpty(),
                                tools = m.meta?.tools.orEmpty().map { t ->
                                    UiTool(t.server, t.name, if (t.ok) "done" else "error")
                                },
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
        viewModelScope.launch {
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
                attachments = (imgs + it.attachments).take(ChatUiState.MAX_ATTACHMENTS),
            )
        }
    }

    fun setInput(text: String) = _state.update { it.copy(input = text) }

    fun addAttachment(bytes: ByteArray, mime: String?) {
        if (_state.value.noVision) {
            _state.update { it.copy(error = "no_vision_model") }
            return
        }
        when (val r = AttachmentEncoder.encode(bytes, mime)) {
            is AttachmentEncoder.Result.Err -> _state.update { it.copy(error = r.code) }
            is AttachmentEncoder.Result.Ok -> _state.update {
                if (it.attachments.size >= ChatUiState.MAX_ATTACHMENTS) it.copy(error = "attachment_too_many")
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
        streamJob = viewModelScope.launch {
            client.chatStream(
                ChatRequestBody(
                    message = text,
                    threadId = s.threadId,
                    model = s.pickedModel ?: s.defaultModel,
                    attachments = if (images.isEmpty() && audioUrl == null) {
                        null
                    } else {
                        ChatAttachments(images = images.ifEmpty { null }, audio = audioUrl)
                    },
                ),
            ).collect { ev ->
                when (ev) {
                    is ChatEvent.ThreadId -> {
                        sawThreadId = true
                        _state.update { it.copy(threadId = ev.id) }
                    }
                    is ChatEvent.Delta -> _state.update {
                        val msgs = it.messages.toMutableList()
                        val last = msgs.last().copy(text = msgs.last().text + ev.text)
                        msgs[msgs.lastIndex] = last
                        it.copy(messages = msgs)
                    }
                    is ChatEvent.ToolProgress -> _state.update {
                        val msgs = it.messages.toMutableList()
                        val last = msgs.last()
                        val tool = UiTool(ev.server, ev.name, ev.status)
                        val tools = last.tools.toMutableList()
                        val idx = tools.indexOfLast { tl -> tl.server == ev.server && tl.name == ev.name }
                        if (idx >= 0) tools[idx] = tool else tools.add(tool)
                        msgs[msgs.lastIndex] = last.copy(tools = tools)
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
                if (last.text.isNotEmpty() || last.tools.isNotEmpty()) {
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

    class Factory(private val store: SessionStore, private val client: YashaClient) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
            ChatViewModel(store, client) as T
    }
}

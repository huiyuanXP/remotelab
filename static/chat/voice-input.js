"use strict";

const voiceInputBtn = document.getElementById("voiceInputBtn");
const voiceFileInput = document.getElementById("voiceFileInput");
const voiceInputStatus = document.getElementById("voiceInputStatus");
const voiceSettingsMount = document.getElementById("voiceSettingsMount");

const VOICE_INPUT_PREFS_KEY = "voiceInputPrefs";
const DEFAULT_VOICE_INPUT_PREFS = Object.freeze({
  attachOriginalAudio: true,
  autoSend: false,
});

const voiceState = {
  config: null,
  loadingConfig: false,
  busy: false,
  recording: false,
  recorder: null,
  stream: null,
  chunks: [],
  startedAt: 0,
  timerId: 0,
  statusTimerId: 0,
};

const scheduleTimeout =
  (typeof window !== "undefined" && typeof window.setTimeout === "function" && window.setTimeout.bind(window))
  || (typeof globalThis.setTimeout === "function" && globalThis.setTimeout.bind(globalThis));
const cancelTimeout =
  (typeof window !== "undefined" && typeof window.clearTimeout === "function" && window.clearTimeout.bind(window))
  || (typeof globalThis.clearTimeout === "function" && globalThis.clearTimeout.bind(globalThis));
const scheduleInterval =
  (typeof window !== "undefined" && typeof window.setInterval === "function" && window.setInterval.bind(window))
  || (typeof globalThis.setInterval === "function" && globalThis.setInterval.bind(globalThis));
const cancelInterval =
  (typeof window !== "undefined" && typeof window.clearInterval === "function" && window.clearInterval.bind(window))
  || (typeof globalThis.clearInterval === "function" && globalThis.clearInterval.bind(globalThis));

function readVoiceInputPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_INPUT_PREFS_KEY) || "null");
    return {
      attachOriginalAudio: raw?.attachOriginalAudio !== false,
      autoSend: raw?.autoSend === true,
    };
  } catch {
    return { ...DEFAULT_VOICE_INPUT_PREFS };
  }
}

function writeVoiceInputPrefs(nextPrefs = {}) {
  const prefs = {
    attachOriginalAudio: nextPrefs.attachOriginalAudio !== false,
    autoSend: nextPrefs.autoSend === true,
  };
  localStorage.setItem(VOICE_INPUT_PREFS_KEY, JSON.stringify(prefs));
  return prefs;
}

function setVoiceInputStatus(message, { error = false, persist = false } = {}) {
  if (!voiceInputStatus) return;
  cancelTimeout?.(voiceState.statusTimerId);
  const text = typeof message === "string" ? message.trim() : "";
  voiceInputStatus.textContent = text;
  voiceInputStatus.classList.toggle("visible", !!text);
  voiceInputStatus.classList.toggle("is-error", !!text && !!error);
  if (text && !persist) {
    voiceState.statusTimerId = scheduleTimeout?.(() => {
      if (!voiceState.recording && !voiceState.busy) {
        setVoiceInputStatus("");
      }
    }, error ? 5000 : 3200);
  }
}

function formatRecordingDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function isOwnerView() {
  return pageBootstrap?.auth?.role !== "visitor";
}

function canUseVoiceInput() {
  return !!voiceState.config?.enabled
    && !!voiceState.config?.configured
    && !(typeof shareSnapshotMode !== "undefined" && shareSnapshotMode);
}

function syncVoiceInputButton() {
  if (!voiceInputBtn) return;
  const disabled = voiceState.busy
    || (!voiceState.recording && !canUseVoiceInput());
  voiceInputBtn.disabled = !!disabled;
  voiceInputBtn.classList.toggle("is-recording", voiceState.recording);
  voiceInputBtn.classList.toggle("is-busy", voiceState.busy && !voiceState.recording);
  voiceInputBtn.setAttribute("aria-pressed", voiceState.recording ? "true" : "false");
  if (voiceState.recording) {
    voiceInputBtn.title = "Stop recording";
    voiceInputBtn.setAttribute("aria-label", "Stop recording");
    return;
  }
  if (voiceState.busy) {
    voiceInputBtn.title = "Transcribing voice";
    voiceInputBtn.setAttribute("aria-label", "Transcribing voice");
    return;
  }
  if (!voiceState.config?.configured) {
    voiceInputBtn.title = isOwnerView() ? "Configure voice input in Settings" : "Voice input is unavailable";
    voiceInputBtn.setAttribute("aria-label", voiceInputBtn.title);
    return;
  }
  if (!voiceState.config?.enabled) {
    voiceInputBtn.title = "Voice input is turned off in Settings";
    voiceInputBtn.setAttribute("aria-label", voiceInputBtn.title);
    return;
  }
  voiceInputBtn.title = "Record voice";
  voiceInputBtn.setAttribute("aria-label", "Record voice");
}

function stopVoiceInputClock() {
  cancelInterval?.(voiceState.timerId);
  voiceState.timerId = 0;
}

function startVoiceInputClock() {
  stopVoiceInputClock();
  voiceState.startedAt = Date.now();
  setVoiceInputStatus(`Recording… tap again to finish · ${formatRecordingDuration(0)}`, { persist: true });
  voiceState.timerId = scheduleInterval?.(() => {
    if (!voiceState.recording || !voiceState.startedAt) return;
    setVoiceInputStatus(
      `Recording… tap again to finish · ${formatRecordingDuration(Date.now() - voiceState.startedAt)}`,
      { persist: true },
    );
  }, 400);
}

function stopVoiceTracks() {
  if (!voiceState.stream) return;
  for (const track of voiceState.stream.getTracks()) {
    track.stop();
  }
  voiceState.stream = null;
}

function resetVoiceRecorderState() {
  stopVoiceInputClock();
  stopVoiceTracks();
  voiceState.recording = false;
  voiceState.recorder = null;
  voiceState.chunks = [];
  voiceState.startedAt = 0;
  syncVoiceInputButton();
}

function deriveVoiceFileExtension(mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  return "webm";
}

function buildRecordedAudioFile(blob) {
  const mimeType = blob?.type || "audio/webm";
  const extension = deriveVoiceFileExtension(mimeType);
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const filename = `voice-${timestamp}.${extension}`;
  if (typeof File === "function") {
    return new File([blob], filename, { type: mimeType });
  }
  const fallback = new Blob([blob], { type: mimeType });
  fallback.name = filename;
  return fallback;
}

function pickRecorderMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "audio/webm",
    "audio/ogg",
  ];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || "";
}

async function insertVoiceTranscriptIntoComposer(transcript) {
  const normalized = typeof transcript === "string" ? transcript.trim() : "";
  if (!normalized) return false;
  const currentValue = typeof msgInput.value === "string" ? msgInput.value : "";
  const nextValue = currentValue.trim()
    ? `${currentValue.replace(/\s+$/, "")}\n${normalized}`
    : normalized;
  msgInput.value = nextValue;
  msgInput.dispatchEvent(new Event("input", { bubbles: true }));
  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: true });
  } else {
    msgInput.focus();
  }
  return !currentValue.trim();
}

function queueVoiceAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return false;
  pendingImages.push({
    filename: attachment.filename,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
  });
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  return true;
}

async function submitVoiceAudio(file) {
  if (!currentSessionId) {
    setVoiceInputStatus("先打开一个会话，再发语音。", { error: true });
    return;
  }
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    setVoiceInputStatus("当前消息还在发送中，等它结束后再录。", { error: true });
    return;
  }
  const prefs = readVoiceInputPrefs();
  voiceState.busy = true;
  syncVoiceInputButton();
  setVoiceInputStatus("正在转写语音…", { persist: true });
  try {
    const formData = new FormData();
    formData.set("audio", file, file?.name || "voice-input");
    if (voiceState.config?.language) formData.set("language", voiceState.config.language);
    formData.set("persistAudio", prefs.attachOriginalAudio ? "true" : "false");
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/voice-transcriptions`, {
      method: "POST",
      body: formData,
    });
    if (prefs.attachOriginalAudio && data?.attachment) {
      queueVoiceAttachment(data.attachment);
    }
    const insertedIntoEmptyComposer = await insertVoiceTranscriptIntoComposer(data?.transcript || "");
    if (prefs.autoSend && insertedIntoEmptyComposer && typeof data?.transcript === "string" && data.transcript.trim() && typeof sendMessage === "function") {
      setVoiceInputStatus("已转写，正在发送…", { persist: true });
      sendMessage();
      return;
    }
    if (typeof data?.transcript === "string" && data.transcript.trim()) {
      setVoiceInputStatus(
        prefs.attachOriginalAudio && data?.attachment
          ? "已转写并附上原音频，可直接发送或先改字。"
          : "已转写到输入框，可直接发送或先改字。",
      );
      return;
    }
    if (prefs.attachOriginalAudio && data?.attachment) {
      setVoiceInputStatus("原音频已附上，但这次没有识别出文本。可以手动补一句再发。", { persist: true });
      if (typeof focusComposer === "function") {
        focusComposer({ force: true, preventScroll: true });
      }
      return;
    }
    setVoiceInputStatus("这次没有识别出文本。再试一遍或者直接手动输入。", { error: true });
  } catch (error) {
    setVoiceInputStatus(error?.message || "语音转写失败了，再试一次。", { error: true });
  } finally {
    voiceState.busy = false;
    syncVoiceInputButton();
  }
}

async function stopVoiceRecording() {
  if (!voiceState.recorder || voiceState.recorder.state === "inactive") return;
  setVoiceInputStatus("正在结束录音…", { persist: true });
  voiceState.recorder.stop();
}

async function startVoiceRecording() {
  if (!canUseVoiceInput()) {
    if (isOwnerView() && typeof switchTab === "function") {
      switchTab("settings");
      setVoiceInputStatus("先在 Settings 里配好语音输入。", { error: true });
      return;
    }
    setVoiceInputStatus("语音输入当前不可用。", { error: true });
    return;
  }
  if (!currentSessionId) {
    setVoiceInputStatus("先打开一个会话，再开始录音。", { error: true });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    voiceFileInput?.click();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickRecorderMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    voiceState.stream = stream;
    voiceState.recorder = recorder;
    voiceState.chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event?.data && event.data.size > 0) {
        voiceState.chunks.push(event.data);
      }
    });
    recorder.addEventListener("stop", async () => {
      const chunks = voiceState.chunks.slice();
      const resolvedType = recorder.mimeType || mimeType || "audio/webm";
      resetVoiceRecorderState();
      if (chunks.length === 0) {
        setVoiceInputStatus("没有录到有效音频，再试一次。", { error: true });
        return;
      }
      const blob = new Blob(chunks, { type: resolvedType });
      await submitVoiceAudio(buildRecordedAudioFile(blob));
    }, { once: true });
    recorder.start();
    voiceState.recording = true;
    syncVoiceInputButton();
    startVoiceInputClock();
  } catch (error) {
    resetVoiceRecorderState();
    setVoiceInputStatus("麦克风不可用，改用系统文件选择。", { error: true });
    voiceFileInput?.click();
  }
}

async function handleVoiceInputClick() {
  if (voiceState.busy) return;
  if (voiceState.recording) {
    await stopVoiceRecording();
    return;
  }
  await startVoiceRecording();
}

async function loadVoiceInputConfig() {
  if (typeof fetchJsonOrRedirect !== "function") {
    return voiceState.config;
  }
  if (voiceState.loadingConfig) return voiceState.config;
  voiceState.loadingConfig = true;
  syncVoiceInputButton();
  try {
    const data = await fetchJsonOrRedirect("/api/voice-input/config");
    voiceState.config = data?.config || null;
  } catch {
    voiceState.config = null;
  } finally {
    voiceState.loadingConfig = false;
    syncVoiceInputButton();
    renderVoiceInputSettings();
  }
  return voiceState.config;
}

function createVoiceSettingsCheckbox(labelText, checked) {
  const chip = document.createElement("label");
  chip.className = "settings-app-chip";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  const text = document.createElement("span");
  text.textContent = labelText;
  chip.appendChild(input);
  chip.appendChild(text);
  return { chip, input };
}

function renderVoiceInputSettings() {
  if (!voiceSettingsMount) return;
  voiceSettingsMount.innerHTML = "";
  if (!isOwnerView()) return;

  const prefs = readVoiceInputPrefs();
  const config = voiceState.config || {};

  const title = document.createElement("div");
  title.className = "settings-section-title";
  title.textContent = "Voice Input";

  const note = document.createElement("div");
  note.className = "settings-section-note";
  note.textContent = "Record on phone or desktop, transcribe on the server, and optionally keep the original audio attached to the message.";

  const form = document.createElement("div");
  form.className = "settings-inline-form";

  const enableRow = document.createElement("div");
  enableRow.className = "settings-app-picker-grid";
  const enabledControl = createVoiceSettingsCheckbox("Enable voice input", config.enabled !== false);
  const attachControl = createVoiceSettingsCheckbox("Attach original audio by default", prefs.attachOriginalAudio !== false);
  const autoSendControl = createVoiceSettingsCheckbox("Auto-send when transcript lands in an empty composer", prefs.autoSend === true);
  enableRow.appendChild(enabledControl.chip);
  enableRow.appendChild(attachControl.chip);
  enableRow.appendChild(autoSendControl.chip);

  const appIdInput = document.createElement("input");
  appIdInput.className = "settings-inline-input";
  appIdInput.type = "text";
  appIdInput.placeholder = "Volcengine App ID";
  appIdInput.value = config.appId || "";

  const accessKeyInput = document.createElement("input");
  accessKeyInput.className = "settings-inline-input";
  accessKeyInput.type = "password";
  accessKeyInput.placeholder = config.hasAccessKey ? "Access key already configured — leave blank to keep it" : "Volcengine Access Key";

  const resourceIdInput = document.createElement("input");
  resourceIdInput.className = "settings-inline-input";
  resourceIdInput.type = "text";
  resourceIdInput.placeholder = "Resource ID";
  resourceIdInput.value = config.resourceId || "";

  const endpointInput = document.createElement("input");
  endpointInput.className = "settings-inline-input";
  endpointInput.type = "text";
  endpointInput.placeholder = "Voice websocket endpoint";
  endpointInput.value = config.endpoint || "";

  const languageInput = document.createElement("input");
  languageInput.className = "settings-inline-input";
  languageInput.type = "text";
  languageInput.placeholder = "Language hint, e.g. zh-CN";
  languageInput.value = config.language || "";

  const modelLabelInput = document.createElement("input");
  modelLabelInput.className = "settings-inline-input";
  modelLabelInput.type = "text";
  modelLabelInput.placeholder = "Model label shown in UI";
  modelLabelInput.value = config.modelLabel || "";

  const actionRow = document.createElement("div");
  actionRow.className = "settings-inline-row";

  const saveBtn = document.createElement("button");
  saveBtn.className = "settings-app-btn settings-inline-primary";
  saveBtn.type = "button";
  saveBtn.textContent = "Save Voice Input";

  const status = document.createElement("div");
  status.className = "settings-app-empty inline-status";
  status.textContent = config.configured
    ? `${config.providerLabel || "Provider"} is ready. Current model: ${config.modelLabel || "voice"}.`
    : "Not configured yet. Save your provider details once, then the mic button becomes available in the composer.";

  saveBtn.addEventListener("click", async () => {
    const nextPrefs = writeVoiceInputPrefs({
      attachOriginalAudio: attachControl.input.checked,
      autoSend: autoSendControl.input.checked,
    });
    status.textContent = "Saving…";
    saveBtn.disabled = true;
    try {
      const payload = {
        enabled: enabledControl.input.checked,
        appId: appIdInput.value.trim(),
        endpoint: endpointInput.value.trim(),
        resourceId: resourceIdInput.value.trim(),
        language: languageInput.value.trim(),
        modelLabel: modelLabelInput.value.trim(),
      };
      if (accessKeyInput.value.trim()) {
        payload.accessKey = accessKeyInput.value.trim();
      }
      const data = await fetchJsonOrRedirect("/api/voice-input/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      voiceState.config = data?.config || voiceState.config;
      accessKeyInput.value = "";
      status.textContent = nextPrefs.attachOriginalAudio
        ? "Saved. New recordings keep the original audio attached by default."
        : "Saved. New recordings only insert transcript text by default.";
      syncVoiceInputButton();
      renderVoiceInputSettings();
    } catch (error) {
      status.textContent = error?.message || "Failed to save voice input settings.";
    } finally {
      saveBtn.disabled = false;
    }
  });

  actionRow.appendChild(saveBtn);
  form.appendChild(enableRow);
  form.appendChild(appIdInput);
  form.appendChild(accessKeyInput);
  form.appendChild(resourceIdInput);
  form.appendChild(endpointInput);
  form.appendChild(languageInput);
  form.appendChild(modelLabelInput);
  form.appendChild(actionRow);
  form.appendChild(status);

  voiceSettingsMount.appendChild(title);
  voiceSettingsMount.appendChild(note);
  voiceSettingsMount.appendChild(form);
}

voiceInputBtn?.addEventListener("click", () => {
  void handleVoiceInputClick();
});

voiceFileInput?.addEventListener("change", () => {
  const file = voiceFileInput.files?.[0];
  voiceFileInput.value = "";
  if (!file) return;
  void submitVoiceAudio(file);
});

window.addEventListener("beforeunload", () => {
  stopVoiceInputClock();
  stopVoiceTracks();
});

scheduleInterval?.(() => {
  syncVoiceInputButton();
}, 800);

syncVoiceInputButton();
if (typeof fetchJsonOrRedirect === "function") {
  void loadVoiceInputConfig();
}

window.RemoteLabVoiceInput = Object.freeze({
  refreshConfig: loadVoiceInputConfig,
  sync: syncVoiceInputButton,
});

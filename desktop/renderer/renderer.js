const { ipcRenderer } = require("electron");
const PIXI = require("pixi.js");
const path = require("path");
const { pathToFileURL } = require("url");

globalThis.PIXI = PIXI;

const cubism2RuntimePath = path.join(__dirname, "vendor", "live2d.min.js");
const cubism4CorePath = require.resolve("@ai-zen/live2d-core/live2dcubismcore.min.js");

const MODEL_MAP = {
  // --- Cubism 4 (moc3) ---
  hiyori:      { local: path.join(__dirname, "models", "Hiyori", "Hiyori.model3.json") },
  // --- Cubism 2 (moc) ---
  koharu:      { pkg: "live2d-widget-model-koharu/assets/koharu.model.json" },
  shizuku:     { pkg: "live2d-widget-model-shizuku/assets/shizuku.model.json" },
  miku:        { pkg: "live2d-widget-model-miku/assets/miku.model.json" },
  hijiki:      { pkg: "live2d-widget-model-hijiki/assets/hijiki.model.json" },
  tororo:      { pkg: "live2d-widget-model-tororo/assets/tororo.model.json" },
  haruto:      { pkg: "live2d-widget-model-haruto/assets/haruto.model.json" },
  wanko:       { pkg: "live2d-widget-model-wanko/assets/wanko.model.json" },
  z16:         { pkg: "live2d-widget-model-z16/assets/z16.model.json" },
  "ni-j":      { pkg: "live2d-widget-model-ni-j/assets/ni-j.model.json" },
  epsilon2_1:  { pkg: "live2d-widget-model-epsilon2_1/assets/Epsilon2.1.model.json" },
};

let currentModelKey = "hiyori";

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const voiceInBtn = document.getElementById("voice-in");
const voiceOutBtn = document.getElementById("voice-out");
const clickThroughEl = document.getElementById("click-through");
const pinTopEl = document.getElementById("pin-top");
const opacityEl = document.getElementById("opacity");
const visionEnabledEl = document.getElementById("vision-enabled");
const proactiveEnabledEl = document.getElementById("proactive-enabled");
const captureIntervalEl = document.getElementById("capture-interval");
const visionStatusEl = document.getElementById("vision-status");
const proactiveStatusEl = document.getElementById("proactive-status");
const proactiveIdleEl = document.getElementById("proactive-idle");
const proactiveCooldownEl = document.getElementById("proactive-cooldown");
const proactiveMaxEl = document.getElementById("proactive-max");
const proactiveChanceEl = document.getElementById("proactive-chance");
const proactiveQuietStartEl = document.getElementById("proactive-quiet-start");
const proactiveQuietEndEl = document.getElementById("proactive-quiet-end");
const canvas = document.getElementById("live2d-canvas");
const modelSelectEl = document.getElementById("model-select");
const avatarSizeEl = document.getElementById("avatar-size");

let ttsEnabled = true;
let model = null;
let currentAudio = null;
let currentAudioUrl = null;
let live2dApp = null;
let modelBaseWidth = 0;
let modelBaseHeight = 0;
let mediaRecorder = null;
let mediaStream = null;
let isRecording = false;
let recorderChunks = [];
const WAKE_WORD = "babe";
const WAKE_WORD_PREFIX = /^(?:hey\s+)?babe\b[\s,:;.!?-]*/i;

async function ensureCubism2Runtime() {
  if (window.Live2D && window.Live2DModelWebGL) {
    return;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = pathToFileURL(cubism2RuntimePath).href;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load local Cubism 2 runtime"));
    document.head.appendChild(script);
  });

  if (!window.Live2D || !window.Live2DModelWebGL) {
    throw new Error("Cubism 2 runtime exports are missing");
  }
}

async function ensureCubism4Runtime() {
  if (window.Live2DCubismCore) {
    return;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = pathToFileURL(cubism4CorePath).href;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Cubism 4 core"));
    document.head.appendChild(script);
  });

  if (!window.Live2DCubismCore) {
    throw new Error("Cubism 4 runtime (Live2DCubismCore) is missing after load");
  }
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function stopSpeechPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

async function speak(text) {
  if (!ttsEnabled || !text) {
    return;
  }

  stopSpeechPlayback();

  const payload = await ipcRenderer.invoke("overlay:tts", text);
  if (!payload || !payload.audioBase64) {
    throw new Error("ElevenLabs did not return audio");
  }

  const mimeType = String(payload.mimeType || "audio/mpeg");
  const binary = atob(payload.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  currentAudioUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  currentAudio = new Audio(currentAudioUrl);
  currentAudio.onended = () => {
    stopSpeechPlayback();
  };
  await currentAudio.play();
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) {
    return;
  }

  addMessage("user", text);
  inputEl.value = "";

  try {
    const response = await ipcRenderer.invoke("overlay:send", { text });
    addMessage("bot", response || "(No response)");
    await speak(response || "");
    if (model && model.motion) {
      try {
        model.motion("tap_body");
      } catch (_err) {
      }
    }
  } catch (err) {
    addMessage("bot", `Error: ${String(err.message || err)}`);
  }
}

function getModelURL(key) {
  const entry = MODEL_MAP[key];
  if (!entry) return null;
  if (entry.local) return pathToFileURL(entry.local).href;
  const resolved = require.resolve(entry.pkg);
  return pathToFileURL(resolved).href;
}

async function loadLive2D() {
  try {
    await ensureCubism2Runtime();
  } catch (err) {
    addMessage("bot", `[live2d] Cubism 2 runtime failed: ${String(err.message || err)}`);
  }

  try {
    await ensureCubism4Runtime();
  } catch (err) {
    addMessage("bot", `[live2d] Cubism 4 runtime failed: ${String(err.message || err)}`);
  }

  const { Live2DModel } = require("pixi-live2d-display");

  const app = new PIXI.Application({
    view: canvas,
    resizeTo: canvas.parentElement,
    transparent: true,
    antialias: true,
  });

  const url = getModelURL(currentModelKey);
  if (!url) {
    addMessage("bot", `Unknown model: ${currentModelKey}`);
    return;
  }

  try {
    model = await Live2DModel.from(url, { autoInteract: true });
  } catch (err) {
    addMessage("bot", `[live2d] Failed to load ${currentModelKey}: ${String(err.message || err)}`);
    return;
  }

  live2dApp = app;
  app.stage.addChild(model);
  model.anchor.set(0.5, 0.5);
  cacheModelBaseSize();

  fitLive2DModel();
  window.addEventListener("resize", fitLive2DModel);
}

async function swapModel(key) {
  if (!live2dApp || key === currentModelKey) return;

  const url = getModelURL(key);
  if (!url) {
    addMessage("bot", `Unknown model: ${key}`);
    return;
  }

  const { Live2DModel } = require("pixi-live2d-display");

  let newModel;
  try {
    newModel = await Live2DModel.from(url, { autoInteract: true });
  } catch (err) {
    addMessage("bot", `[live2d] Failed to load ${key}: ${String(err.message || err)}`);
    return;
  }

  // Remove old model
  if (model) {
    live2dApp.stage.removeChild(model);
    model.destroy();
  }

  model = newModel;
  currentModelKey = key;
  live2dApp.stage.addChild(model);
  model.anchor.set(0.5, 0.5);
  cacheModelBaseSize();
  fitLive2DModel();
}

function cacheModelBaseSize() {
  if (!model) {
    modelBaseWidth = 0;
    modelBaseHeight = 0;
    return;
  }

  let baseWidth = 0;
  let baseHeight = 0;

  try {
    const bounds = model.getLocalBounds();
    baseWidth = Math.abs(Number(bounds.width)) || 0;
    baseHeight = Math.abs(Number(bounds.height)) || 0;
  } catch (_err) {
  }

  if (!(baseWidth > 0) || !(baseHeight > 0)) {
    const scaleX = Math.abs(Number(model.scale && model.scale.x)) || 1;
    const scaleY = Math.abs(Number(model.scale && model.scale.y)) || 1;
    baseWidth = Math.abs(Number(model.width)) / scaleX;
    baseHeight = Math.abs(Number(model.height)) / scaleY;
  }

  if (baseWidth > 0 && baseHeight > 0) {
    modelBaseWidth = baseWidth;
    modelBaseHeight = baseHeight;
  }
}

function applyModelScale() {
  if (!model || !live2dApp) return;
  if (!(modelBaseWidth > 0) || !(modelBaseHeight > 0)) {
    cacheModelBaseSize();
  }
  if (!(modelBaseWidth > 0) || !(modelBaseHeight > 0)) {
    return;
  }

  const { width, height } = live2dApp.screen;
  const sliderValue = Number(avatarSizeEl.value);
  const sizeFactor = Math.max(0.1, Number.isFinite(sliderValue) ? sliderValue / 100 : 1);
  const baseScale = Math.min(width / modelBaseWidth, height / modelBaseHeight);
  const scale = baseScale * sizeFactor;
  const scaledH = modelBaseHeight * scale;
  model.scale.set(scale);
  model.x = width * 0.5;
  if (scaledH <= height) {
    model.y = height - scaledH * 0.5;
  } else {
    model.y = height * 0.5;
  }
}

function fitLive2DModel() {
  if (!live2dApp) return;
  live2dApp.resize();
  applyModelScale();
}

function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return "";
}

function stopMicStream() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }
}

async function stopVoiceRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return null;
  }

  voiceInBtn.disabled = true;
  voiceInBtn.textContent = "...";

  return new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || "audio/webm";
      const blob = new Blob(recorderChunks, { type: mimeType });
      recorderChunks = [];
      mediaRecorder = null;
      isRecording = false;
      stopMicStream();
      resolve({ blob, mimeType });
    };
    mediaRecorder.stop();
  });
}

async function transcribeVoice(blob, mimeType) {
  const buffer = await blob.arrayBuffer();
  const audioBase64 = Buffer.from(buffer).toString("base64");

  const payload = await ipcRenderer.invoke("overlay:transcribe-audio", {
    audioBase64,
    mimeType,
  });

  const text = String(payload && payload.text ? payload.text : "").trim();
  const error = String(payload && payload.error ? payload.error : "").trim();
  return { text, error };
}

function extractCommandFromWakeWord(transcript) {
  const original = String(transcript || "").trim();
  if (!original) {
    return null;
  }

  if (!WAKE_WORD_PREFIX.test(original)) {
    return null;
  }

  return original.replace(WAKE_WORD_PREFIX, "").trim();
}

async function startVoiceRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    addMessage("bot", "[voice] Mic recording is not supported in this environment.");
    return;
  }

  const permission = await ipcRenderer.invoke("overlay:ensure-mic-permission");
  if (!permission || !permission.granted) {
    addMessage("bot", "[voice] Microphone permission denied. Enable it in macOS Settings > Privacy & Security > Microphone.");
    voiceInBtn.textContent = "Mic";
    return;
  }

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    addMessage("bot", "[voice] No supported audio recording format was found.");
    return;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  recorderChunks = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recorderChunks.push(event.data);
    }
  };

  mediaRecorder.onerror = () => {
    addMessage("bot", "[voice] Recording failed. Please try again.");
    isRecording = false;
    voiceInBtn.textContent = "Mic";
    voiceInBtn.disabled = false;
    stopMicStream();
  };

  mediaRecorder.start();
  isRecording = true;
  voiceInBtn.textContent = "Stop";
}

sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

function toggleVoiceRecording() {
  if (isRecording) {
    stopVoiceRecording()
      .then(async (result) => {
        if (!result || !result.blob || result.blob.size === 0) {
          return;
        }

        voiceInBtn.textContent = "Transcribing";
        const transcription = await transcribeVoice(result.blob, result.mimeType);
        if (transcription.text) {
          const command = extractCommandFromWakeWord(transcription.text);
          if (command === null) {
            addMessage("bot", `[voice] Say \"${WAKE_WORD}\" first to activate voice command.`);
            return;
          }
          if (!command) {
            addMessage("bot", `[voice] Wake word heard. Say a command after \"${WAKE_WORD}\".`);
            return;
          }

          inputEl.value = command;
          await sendMessage();
        } else if (transcription.error) {
          addMessage("bot", `[voice] ${transcription.error}`);
        } else {
          addMessage("bot", "[voice] No speech detected.");
        }
      })
      .catch((err) => {
        addMessage("bot", `[voice] ${String(err.message || err)}`);
      })
      .finally(() => {
        isRecording = false;
        voiceInBtn.textContent = "Mic";
        voiceInBtn.disabled = false;
      });
    return;
  }

  voiceInBtn.disabled = true;
  voiceInBtn.textContent = "...";
  startVoiceRecording()
    .catch((err) => {
      addMessage("bot", `[voice] ${String(err.message || err)}`);
      stopMicStream();
      isRecording = false;
      voiceInBtn.textContent = "Mic";
    })
    .finally(() => {
      voiceInBtn.disabled = false;
    });
}

voiceInBtn.addEventListener("click", toggleVoiceRecording);

ipcRenderer.on("overlay:voice-shortcut", () => {
  toggleVoiceRecording();
});

voiceOutBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  voiceOutBtn.textContent = ttsEnabled ? "Voice" : "Muted";
  if (!ttsEnabled) {
    stopSpeechPlayback();
  }
});

clickThroughEl.addEventListener("change", () => {
  ipcRenderer.send("overlay:set-click-through", clickThroughEl.checked);
});

pinTopEl.addEventListener("change", () => {
  ipcRenderer.send("overlay:pin-top", pinTopEl.checked);
});

opacityEl.addEventListener("input", () => {
  ipcRenderer.send("overlay:set-opacity", Number(opacityEl.value) / 100);
});

modelSelectEl.addEventListener("change", () => {
  swapModel(modelSelectEl.value);
});

let sizeRafPending = false;
avatarSizeEl.addEventListener("input", () => {
  if (sizeRafPending) return;
  sizeRafPending = true;
  requestAnimationFrame(() => {
    sizeRafPending = false;
    applyModelScale();
  });
});

visionEnabledEl.addEventListener("change", () => {
  ipcRenderer.send("overlay:set-background-vision", visionEnabledEl.checked);
});

captureIntervalEl.addEventListener("change", () => {
  const seconds = Number(captureIntervalEl.value);
  ipcRenderer.send("overlay:set-capture-interval", seconds);
});

proactiveEnabledEl.addEventListener("change", () => {
  ipcRenderer.send("overlay:set-proactive", proactiveEnabledEl.checked);
});

function bindProactiveConfigInput(inputEl, field) {
  inputEl.addEventListener("change", () => {
    const value = Number(inputEl.value);
    ipcRenderer.invoke("overlay:set-proactive-config", { [field]: value })
      .then((status) => {
        updateProactiveStatus(status);
      })
      .catch((err) => {
        addMessage("bot", `[proactive] ${String(err.message || err)}`);
      });
  });
}

bindProactiveConfigInput(proactiveIdleEl, "minIdleMinutes");
bindProactiveConfigInput(proactiveCooldownEl, "cooldownMinutes");
bindProactiveConfigInput(proactiveMaxEl, "maxPerDay");
bindProactiveConfigInput(proactiveChanceEl, "randomChancePercent");
bindProactiveConfigInput(proactiveQuietStartEl, "quietStartHour");
bindProactiveConfigInput(proactiveQuietEndEl, "quietEndHour");

function updateVisionStatus(status) {
  if (!status) {
    visionStatusEl.textContent = "Unknown";
    return;
  }

  visionEnabledEl.checked = Boolean(status.enabled);
  captureIntervalEl.value = String(status.intervalSeconds || 5);
  captureIntervalEl.disabled = !status.enabled;

  if (!status.enabled) {
    visionStatusEl.textContent = "Paused";
  } else if (status.lastError) {
    visionStatusEl.textContent = "Permission needed";
  } else if (status.hasCapture) {
    visionStatusEl.textContent = "Capturing";
  } else {
    visionStatusEl.textContent = "Starting";
  }
}

function updateProactiveStatus(status) {
  if (!status) {
    proactiveStatusEl.textContent = "Nudges: ?";
    return;
  }
  proactiveEnabledEl.checked = Boolean(status.enabled);
  proactiveStatusEl.textContent = `Nudges: ${Number(status.sentToday || 0)}/${Number(status.maxPerDay || 0)}`;
  proactiveIdleEl.value = String(Number(status.minIdleMinutes || 45));
  proactiveCooldownEl.value = String(Number(status.cooldownMinutes || 120));
  proactiveMaxEl.value = String(Number(status.maxPerDay || 2));
  proactiveChanceEl.value = String(Number(status.randomChancePercent || 35));
  proactiveQuietStartEl.value = String(Number(status.quietStartHour ?? 22));
  proactiveQuietEndEl.value = String(Number(status.quietEndHour ?? 8));
}

ipcRenderer.on("backend:ready", () => {
  addMessage("bot", "Nanobot overlay is ready.");
});

ipcRenderer.on("backend:exit", (_event, code) => {
  addMessage("bot", `Backend exited (code ${code}). Restarting...`);
});

ipcRenderer.on("backend:log", (_event, text) => {
  addMessage("bot", `[log] ${text}`);
});

ipcRenderer.on("screen-capture:status", (_event, status) => {
  updateVisionStatus(status);
});

ipcRenderer.on("proactive:status", (_event, status) => {
  updateProactiveStatus(status);
});

ipcRenderer.on("overlay:proactive-message", async (_event, payload) => {
  const text = String(payload && payload.text ? payload.text : "").trim();
  if (!text) {
    return;
  }
  addSystemMessage("Luna checked in");
  addMessage("bot", text);
  try {
    await speak(text);
  } catch (err) {
    addMessage("bot", `[tts] ${String(err.message || err)}`);
  }
});

ipcRenderer.invoke("overlay:get-capture-status")
  .then((status) => {
    updateVisionStatus(status);
  })
  .catch(() => {
    updateVisionStatus(null);
  });

ipcRenderer.invoke("overlay:get-proactive-status")
  .then((status) => {
    updateProactiveStatus(status);
  })
  .catch(() => {
    updateProactiveStatus(null);
  });

// --- Avatar-only / chat toggle ---
const overlayRoot = document.getElementById("overlay-root");

function setChatExpanded(expanded) {
  if (expanded) {
    overlayRoot.classList.remove("avatar-only");
  } else {
    overlayRoot.classList.add("avatar-only");
  }
  ipcRenderer.send("overlay:set-chat-expanded", expanded);
  // Re-fit avatar after window resize settles
  setTimeout(fitLive2DModel, 150);
}

function toggleChat() {
  const isExpanded = !overlayRoot.classList.contains("avatar-only");
  setChatExpanded(!isExpanded);
  if (!isExpanded) {
    inputEl.focus();
  }
}

ipcRenderer.on("overlay:toggle-chat", () => {
  toggleChat();
});

loadLive2D();

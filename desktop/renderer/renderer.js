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
let mediaRecorder = null;
let mediaStream = null;
let isRecording = false;
let recorderChunks = [];
const WAKE_WORD = "babe";
const WAKE_WORD_PREFIX = /^(?:hey\s+)?babe\b[\s,:;.!?-]*/i;

// --- Lip sync state ---
let audioContext = null;
let analyser = null;
let isSpeaking = false;

// --- Idle animation state ---
let nextBlinkTime = 0;
let blinkPhase = 0; // 0=open, 1=closing, 2=opening
let blinkProgress = 0;
let currentEmotion = null;
let emotionTimeout = null;

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
  isSpeaking = false;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

function startLipSync(audioEl) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume in case browser/Electron suspended the context
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  const source = audioContext.createMediaElementSource(audioEl);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  isSpeaking = true;
}

function getLipSyncValue() {
  if (!analyser || !isSpeaking) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  // Focus on voice frequency range (roughly bins 2-20 for speech fundamentals)
  let sum = 0;
  const start = 2;
  const end = Math.min(20, data.length);
  for (let i = start; i < end; i++) {
    sum += data[i];
  }
  const avg = sum / (end - start);
  // Normalize to 0-1 with some amplification
  return Math.min(1, avg / 128);
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

  startLipSync(currentAudio);
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
    // response can be string (old) or { text, emotion } (new)
    let replyText = "";
    let emotion = null;
    if (typeof response === "object" && response !== null) {
      replyText = response.text || "";
      emotion = response.emotion || null;
    } else {
      replyText = response || "";
    }

    addMessage("bot", replyText || "(No response)");

    if (emotion) {
      applyEmotion(emotion);
    }

    await speak(replyText);

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

  fitLive2DModel();
  window.addEventListener("resize", fitLive2DModel);
  hookModelUpdate(model);
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
  hookModelUpdate(model);
  fitLive2DModel();
}

function applyModelScale() {
  if (!model || !live2dApp) return;
  const { width, height } = live2dApp.screen;
  const sizeFactor = Number(avatarSizeEl.value) / 100;
  const baseScale = Math.min(width / model.width, height / model.height);
  const scale = baseScale * sizeFactor;
  const scaledH = model.height * scale;
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

// --- Emotion → parameter presets ---
const EMOTION_PRESETS = {
  happy:     { ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8, ParamMouthForm: 1, ParamAngleX: 5 },
  playful:   { ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamMouthForm: 1, ParamAngleZ: 8 },
  sad:       { ParamBrowLY: -0.5, ParamBrowRY: -0.5, ParamEyeLOpen: 0.6, ParamEyeROpen: 0.6 },
  concerned: { ParamBrowLY: -0.3, ParamBrowRY: -0.3, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 },
  excited:   { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamAngleY: 5, ParamMouthForm: 0.8 },
  thinking:  { ParamEyeBallX: -0.5, ParamEyeBallY: 0.5, ParamEyeLOpen: 0.75, ParamEyeROpen: 0.75 },
};

function applyEmotion(emotion) {
  if (emotionTimeout) clearTimeout(emotionTimeout);
  currentEmotion = emotion || null;

  if (!currentEmotion) return;

  // Auto-clear emotion after 6 seconds
  emotionTimeout = setTimeout(() => {
    currentEmotion = null;
  }, 6000);
}

// --- Hook into model's update cycle ---
// The internal update flow is: motions → save → expressions → eyeBlink →
// focus → naturalMovements → physics → pose → emit("beforeModelUpdate") →
// model.update() [commits params] → loadParameters() [restores saved state].
// We listen to "beforeModelUpdate" so our params are set RIGHT BEFORE commit.
const idleStartTime = performance.now();

function hookModelUpdate(mdl) {
  if (!mdl || !mdl.internalModel) return;
  const internal = mdl.internalModel;

  // Remove any previous listener if we're re-hooking after a model swap
  internal.removeAllListeners("beforeModelUpdate");

  // Hook into the exact right point: after motions/physics/pose are applied,
  // but BEFORE model.update() commits params to the native model.
  internal.on("beforeModelUpdate", () => {
    const core = internal.coreModel;

    // Cubism 4: addParameterValueById(id, value, weight)
    // Cubism 2: addToParamFloat(index, value)
    const isCubism4 = typeof core.addParameterValueById === "function";
    const isCubism2 = typeof core.addToParamFloat === "function";

    const t = (performance.now() - idleStartTime) / 1000;

    // --- Lip sync: override mouth open param with audio amplitude ---
    if (isSpeaking) {
      const mouthVal = getLipSyncValue();
      if (mouthVal > 0) {
        if (isCubism4) {
          // setParameterValueById replaces the value (not additive) so our
          // audio amplitude takes full control of the mouth during speech
          try { core.setParameterValueById("ParamMouthOpenY", mouthVal); } catch (_e) {}
        } else if (isCubism2) {
          try { core.setParamFloat("PARAM_MOUTH_OPEN_Y", mouthVal); } catch (_e) {}
        }
      }
    }

    // --- Breathing (~3s cycle) ---
    const breathVal = 0.5 * Math.sin(t * 2.094);
    if (isCubism4) {
      try { core.addParameterValueById("ParamBreath", breathVal); } catch (_e) {}
    } else if (isCubism2) {
      try { core.addToParamFloat(core.getParamIndex("PARAM_BREATH"), breathVal); } catch (_e) {}
    }

    // --- Head sway (~7s X, ~9s Y) ---
    if (isCubism4) {
      try { core.addParameterValueById("ParamAngleX", 3 * Math.sin(t * 0.898), 0.5); } catch (_e) {}
      try { core.addParameterValueById("ParamAngleY", 2 * Math.sin(t * 0.698), 0.5); } catch (_e) {}
    } else if (isCubism2) {
      try { core.addToParamFloat(core.getParamIndex("PARAM_ANGLE_X"), 3 * Math.sin(t * 0.898) * 0.5); } catch (_e) {}
      try { core.addToParamFloat(core.getParamIndex("PARAM_ANGLE_Y"), 2 * Math.sin(t * 0.698) * 0.5); } catch (_e) {}
    }

    // --- Body sway (~11s, subtle) ---
    if (isCubism4) {
      try { core.addParameterValueById("ParamBodyAngleX", 1.5 * Math.sin(t * 0.571), 0.3); } catch (_e) {}
    } else if (isCubism2) {
      try { core.addToParamFloat(core.getParamIndex("PARAM_BODY_ANGLE_X"), 1.5 * Math.sin(t * 0.571) * 0.3); } catch (_e) {}
    }

    // --- Gaze drift (~5s X, ~6s Y) ---
    if (isCubism4) {
      try { core.addParameterValueById("ParamEyeBallX", 0.3 * Math.sin(t * 1.257), 0.4); } catch (_e) {}
      try { core.addParameterValueById("ParamEyeBallY", 0.2 * Math.sin(t * 1.047), 0.4); } catch (_e) {}
    } else if (isCubism2) {
      try { core.addToParamFloat(core.getParamIndex("PARAM_EYE_BALL_X"), 0.3 * Math.sin(t * 1.257) * 0.4); } catch (_e) {}
      try { core.addToParamFloat(core.getParamIndex("PARAM_EYE_BALL_Y"), 0.2 * Math.sin(t * 1.047) * 0.4); } catch (_e) {}
    }

    // --- Eye blink ---
    const nowMs = performance.now();
    if (blinkPhase === 0 && nowMs >= nextBlinkTime) {
      blinkPhase = 1;
      blinkProgress = 0;
    }
    if (blinkPhase === 1) {
      blinkProgress += 0.15;
      if (blinkProgress >= 1) { blinkPhase = 2; blinkProgress = 1; }
    } else if (blinkPhase === 2) {
      blinkProgress -= 0.12;
      if (blinkProgress <= 0) {
        blinkPhase = 0;
        blinkProgress = 0;
        nextBlinkTime = nowMs + 2000 + Math.random() * 4000;
      }
    }
    if (blinkPhase !== 0) {
      const blinkVal = 1 - blinkProgress; // 1=open, 0=closed
      if (isCubism4) {
        try { core.setParameterValueById("ParamEyeLOpen", blinkVal); } catch (_e) {}
        try { core.setParameterValueById("ParamEyeROpen", blinkVal); } catch (_e) {}
      } else if (isCubism2) {
        try { core.setParamFloat(core.getParamIndex("PARAM_EYE_L_OPEN"), blinkVal); } catch (_e) {}
        try { core.setParamFloat(core.getParamIndex("PARAM_EYE_R_OPEN"), blinkVal); } catch (_e) {}
      }
    }

    // --- Emotion overrides ---
    if (currentEmotion && EMOTION_PRESETS[currentEmotion]) {
      const preset = EMOTION_PRESETS[currentEmotion];
      for (const [param, val] of Object.entries(preset)) {
        if (isCubism4) {
          try { core.addParameterValueById(param, val, 0.7); } catch (_e) {}
        } else if (isCubism2) {
          try { core.addToParamFloat(core.getParamIndex(param), val * 0.7); } catch (_e) {}
        }
      }
    }
  });
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

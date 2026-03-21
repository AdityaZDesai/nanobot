const { ipcRenderer } = require("electron");
const PIXI = require("pixi.js");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

// Patch PIXI batch renderer to survive MAX_TEXTURE_IMAGE_UNITS returning 0.
// Some GPUs / Electron startups report 0 texture units, causing PIXI's
// checkMaxIfStatementsInShader to throw.  We wrap contextChange() to clamp
// MAX_TEXTURES to at least 1 before the shader compile test runs.
try {
  const pixiCore = require("@pixi/core");
  const _origContextChange = pixiCore.AbstractBatchRenderer.prototype.contextChange;
  pixiCore.AbstractBatchRenderer.prototype.contextChange = function () {
    try {
      _origContextChange.call(this);
    } catch (e) {
      if (e.message && e.message.includes("checkMaxIfStatementsInShader")) {
        console.warn("[PIXI patch] GPU returned 0 texture units, falling back to 1");
        this.MAX_TEXTURES = 1;
        this._shader = this.shaderGenerator.generateShader(this.MAX_TEXTURES);
        for (var i = 0; i < this._packedGeometryPoolSize; i++) {
          this._packedGeometries[i] = new (this.geometryClass)();
        }
        this.initFlushBuffers();
      } else {
        throw e;
      }
    }
  };
} catch (_) { /* @pixi/core not available — ignore */ }

// Catch renderer-process errors that would otherwise silently crash
window.addEventListener("error", (e) => {
  console.error("[renderer] Uncaught error:", e.error || e.message);
  ipcRenderer.send("renderer-error", String(e.error?.stack || e.message));
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[renderer] Unhandled rejection:", e.reason);
  ipcRenderer.send("renderer-error", String(e.reason?.stack || e.reason));
});
process.on("uncaughtException", (err) => {
  console.error("[renderer] process uncaughtException:", err);
  ipcRenderer.send("renderer-error", String(err.stack || err));
});

// AvatarController is lazy-loaded because Three.js uses ESM modules
// that can't be require()'d at the top level
let _AvatarControllerClass = null;

globalThis.PIXI = PIXI;

const cubism2RuntimePath = path.join(__dirname, "vendor", "live2d.min.js");
const cubism4CorePath = require.resolve("@ai-zen/live2d-core/live2dcubismcore.min.js");

const MODEL_MAP = {
  // --- Cubism 4 (moc3) ---
  hiyori:      { type: "live2d", local: path.join(__dirname, "models", "Hiyori", "Hiyori.model3.json") },
  // --- Cubism 2 (moc) ---
  koharu:      { type: "live2d", pkg: "live2d-widget-model-koharu/assets/koharu.model.json" },
  shizuku:     { type: "live2d", pkg: "live2d-widget-model-shizuku/assets/shizuku.model.json" },
  miku:        { type: "live2d", pkg: "live2d-widget-model-miku/assets/miku.model.json" },
  hijiki:      { type: "live2d", pkg: "live2d-widget-model-hijiki/assets/hijiki.model.json" },
  tororo:      { type: "live2d", pkg: "live2d-widget-model-tororo/assets/tororo.model.json" },
  haruto:      { type: "live2d", pkg: "live2d-widget-model-haruto/assets/haruto.model.json" },
  wanko:       { type: "live2d", pkg: "live2d-widget-model-wanko/assets/wanko.model.json" },
  z16:         { type: "live2d", pkg: "live2d-widget-model-z16/assets/z16.model.json" },
  "ni-j":      { type: "live2d", pkg: "live2d-widget-model-ni-j/assets/ni-j.model.json" },
  epsilon2_1:  { type: "live2d", pkg: "live2d-widget-model-epsilon2_1/assets/Epsilon2.1.model.json" },
};

// Auto-scan models/3d/ for .glb files and add them to MODEL_MAP
const THREE_D_DIR = path.join(__dirname, "models", "3d");
try {
  const files = fs.readdirSync(THREE_D_DIR).filter((f) => f.endsWith(".glb") || f.endsWith(".gltf"));
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const key = "3d-" + name;
    MODEL_MAP[key] = { type: "three", local: path.join(THREE_D_DIR, file), label: name.replace(/[_-]/g, " ") };
  }
} catch (_) {
  // models/3d/ doesn't exist yet — skip
}

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
const threeCanvas = document.getElementById("three-canvas");
const modelSelectEl = document.getElementById("model-select");
const llmProfileEl = document.getElementById("llm-profile");
const avatarSizeEl = document.getElementById("avatar-size");
const settingsToggleEl = document.getElementById("settings-toggle");
const settingsDrawerEl = document.getElementById("settings-drawer");

let avatarMode = "live2d"; // "live2d" or "three"
let avatar3d = null;       // AvatarController instance

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
const AVATAR_WINDOW_BASE = { width: 300, height: 350 };
const WAKE_WORD = "babe";
const WAKE_WORD_PREFIX = /^(?:hey\s+)?babe\b[\s,:;.!?-]*/i;

// --- Lip sync state ---
let audioContext = null;
let analyser = null;
let isSpeaking = false;
let lipSyncTimeData = null;
let lipSyncLevel = 0;
let lipSyncEnvelope = null;
let lipSyncEnvelopeStep = 0;

function buildLipSyncEnvelope(decodedAudioBuffer) {
  const sampleRate = decodedAudioBuffer.sampleRate;
  const bucketRate = 45;
  const bucketSize = Math.max(256, Math.floor(sampleRate / bucketRate));
  const frameCount = decodedAudioBuffer.length;
  const channelCount = decodedAudioBuffer.numberOfChannels;
  const buckets = Math.ceil(frameCount / bucketSize);
  const envelope = new Float32Array(buckets);

  for (let b = 0; b < buckets; b += 1) {
    const start = b * bucketSize;
    const end = Math.min(frameCount, start + bucketSize);
    let sumSq = 0;
    let count = 0;
    for (let ch = 0; ch < channelCount; ch += 1) {
      const data = decodedAudioBuffer.getChannelData(ch);
      for (let i = start; i < end; i += 1) {
        const s = data[i];
        sumSq += s * s;
      }
      count += end - start;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    const noiseFloor = 0.01;
    const gain = 7.5;
    envelope[b] = Math.max(0, Math.min(1, (rms - noiseFloor) * gain));
  }

  for (let i = 1; i < envelope.length; i += 1) {
    envelope[i] = envelope[i - 1] * 0.25 + envelope[i] * 0.75;
  }

  return {
    envelope,
    stepSeconds: bucketSize / sampleRate,
  };
}

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
  lipSyncLevel = 0;
  lipSyncEnvelope = null;
  lipSyncEnvelopeStep = 0;
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
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  lipSyncTimeData = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  lipSyncLevel = 0;
  isSpeaking = true;
}

function getLipSyncValue() {
  if (!isSpeaking) return 0;

  let envelopeTarget = 0;
  if (currentAudio && lipSyncEnvelope && lipSyncEnvelopeStep > 0) {
    const idx = Math.min(
      lipSyncEnvelope.length - 1,
      Math.max(0, Math.floor(currentAudio.currentTime / lipSyncEnvelopeStep))
    );
    envelopeTarget = lipSyncEnvelope[idx] || 0;
  }

  let analyserTarget = 0;
  if (analyser) {
    if (!lipSyncTimeData || lipSyncTimeData.length !== analyser.fftSize) {
      lipSyncTimeData = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(lipSyncTimeData);

    let sumSquares = 0;
    for (let i = 0; i < lipSyncTimeData.length; i++) {
      const centered = (lipSyncTimeData[i] - 128) / 128;
      sumSquares += centered * centered;
    }

    const rms = Math.sqrt(sumSquares / lipSyncTimeData.length);
    const noiseFloor = 0.015;
    const gain = 6.0;
    analyserTarget = Math.max(0, Math.min(1, (rms - noiseFloor) * gain));
  }

  const target = Math.max(analyserTarget, envelopeTarget);

  const attack = 0.45;
  const release = 0.16;
  const lerp = target > lipSyncLevel ? attack : release;
  lipSyncLevel += (target - lipSyncLevel) * lerp;

  return lipSyncLevel;
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
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  try {
    const decoded = await audioContext.decodeAudioData(bytes.buffer.slice(0));
    const built = buildLipSyncEnvelope(decoded);
    lipSyncEnvelope = built.envelope;
    lipSyncEnvelopeStep = built.stepSeconds;
  } catch (decodeErr) {
    console.warn("[lip-sync] decodeAudioData failed, falling back to analyser-only", decodeErr);
    lipSyncEnvelope = null;
    lipSyncEnvelopeStep = 0;
  }
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

  // PIXI throws when MAX_TEXTURE_IMAGE_UNITS returns 0 (GPU not ready).
  // Retry after a short delay to let the GPU context initialize.
  let app;
  const pixiOpts = { view: canvas, resizeTo: canvas.parentElement, transparent: true, antialias: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      app = new PIXI.Application(pixiOpts);
      break;
    } catch (pixiErr) {
      console.warn(`[live2d] PIXI init attempt ${attempt + 1} failed:`, pixiErr.message);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      } else {
        // Last resort: try with forceCanvas fallback
        try {
          app = new PIXI.Application({ ...pixiOpts, forceCanvas: true });
          console.warn("[live2d] Fell back to Canvas2D renderer");
        } catch (canvasErr) {
          addMessage("bot", `[live2d] Renderer failed: ${String(pixiErr.message)}`);
          return;
        }
      }
    }
  }

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
  const visualScaleFactor = Math.min(sizeFactor, 1);
  const baseScale = Math.min(width / modelBaseWidth, height / modelBaseHeight);
  const scale = baseScale * visualScaleFactor;
  const scaledH = modelBaseHeight * scale;
  model.scale.set(scale);
  model.x = width * 0.5;
  if (scaledH <= height) {
    model.y = height - scaledH * 0.5;
  } else {
    model.y = height * 0.5;
  }
}

function syncAvatarWindowSize() {
  const sliderValue = Number(avatarSizeEl.value);
  const sizeFactor = Math.max(1, Number.isFinite(sliderValue) ? sliderValue / 100 : 1);
  const targetWidth = Math.round(AVATAR_WINDOW_BASE.width * sizeFactor);
  const targetHeight = Math.round(AVATAR_WINDOW_BASE.height * sizeFactor);
  ipcRenderer.send("overlay:avatar-window-size", {
    width: targetWidth,
    height: targetHeight,
  });
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

  // Dispatch to 3D avatar if active
  if (avatarMode === "three" && avatar3d) {
    avatar3d.setEmotion(emotion || "neutral");
    return; // 3D controller handles its own auto-clear
  }

  if (!currentEmotion) return;

  // Auto-clear emotion after 6 seconds (Live2D path)
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
    addMessage("bot", "[voice] Microphone permission denied. Enable it in System Settings > Privacy > Microphone.");
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
    voiceInBtn.classList.remove("recording");
    voiceInBtn.disabled = false;
    stopMicStream();
  };

  mediaRecorder.start();
  isRecording = true;
  voiceInBtn.classList.add("recording");
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
        voiceInBtn.classList.remove("recording");
        voiceInBtn.disabled = false;
      });
    return;
  }

  voiceInBtn.disabled = true;
  startVoiceRecording()
    .catch((err) => {
      addMessage("bot", `[voice] ${String(err.message || err)}`);
      stopMicStream();
      isRecording = false;
      voiceInBtn.classList.remove("recording");
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
  voiceOutBtn.classList.toggle("active", ttsEnabled);
  if (!ttsEnabled) {
    stopSpeechPlayback();
  }
});

// Settings drawer toggle
if (settingsToggleEl && settingsDrawerEl) {
  settingsToggleEl.addEventListener("click", () => {
    settingsDrawerEl.classList.toggle("open");
    settingsToggleEl.classList.toggle("active", settingsDrawerEl.classList.contains("open"));
  });
}

clickThroughEl.addEventListener("change", () => {
  ipcRenderer.send("overlay:set-click-through", clickThroughEl.checked);
});

pinTopEl.addEventListener("change", () => {
  ipcRenderer.send("overlay:pin-top", pinTopEl.checked);
});

opacityEl.addEventListener("input", () => {
  ipcRenderer.send("overlay:set-opacity", Number(opacityEl.value) / 100);
});

modelSelectEl.addEventListener("change", async () => {
  const key = modelSelectEl.value;
  const entry = MODEL_MAP[key];
  if (!entry) return;

  if (entry.type === "three") {
    await switchToThree(key);
  } else {
    await switchToLive2D(key);
  }
});

async function switchToLive2D(key) {
  // Tear down 3D if active (releases the Three.js WebGL context)
  if (avatar3d) {
    avatar3d.dispose();
    avatar3d = null;
  }
  threeCanvas.style.display = "none";
  canvas.style.display = "block";
  avatarMode = "live2d";

  // Always recreate PIXI since we destroy it when switching to 3D
  currentModelKey = key;
  return loadLive2D();
}

function _log3d(msg) {
  console.log(msg);
  try { ipcRenderer.send("renderer-log", msg); } catch (_) {}
}

async function switchToThree(key) {
  try {
    _log3d("[3d] step 1: switchToThree starting, key=" + key);

    // Pause screen capture — desktopCapturer can conflict with WebGL init
    ipcRenderer.send("overlay:set-background-vision", false);

    // Fully destroy PIXI to release its WebGL context
    if (live2dApp) {
      _log3d("[3d] step 2: destroying PIXI...");
      if (model) {
        live2dApp.stage.removeChild(model);
        model.destroy();
        model = null;
      }
      live2dApp.destroy(false); // false = keep the canvas DOM element
      live2dApp = null;
      _log3d("[3d] step 2: PIXI destroyed");
    }

    canvas.style.display = "none";
    threeCanvas.style.display = "block";
    avatarMode = "three";

    // Wait a frame so the canvas gets layout dimensions after display:block
    await new Promise((resolve) => requestAnimationFrame(resolve));
    _log3d("[3d] step 3: canvas laid out, size=" + threeCanvas.clientWidth + "x" + threeCanvas.clientHeight);

    // Quick bare WebGL sanity check (probe canvas only)
    _log3d("[3d] step 4: testing bare WebGL...");
    const glProbeCanvas = document.createElement("canvas");
    const testGL = glProbeCanvas.getContext("webgl2") || glProbeCanvas.getContext("webgl");
    if (!testGL) {
      throw new Error("WebGL not available on three-canvas");
    }
    _log3d("[3d] step 4: bare WebGL OK: " + testGL.getParameter(testGL.VERSION));

    // Lazy-load AvatarController
    if (!_AvatarControllerClass) {
      _log3d("[3d] step 5: requiring AvatarController module...");
      const mod = require("./avatar3d/AvatarController");
      _AvatarControllerClass = mod.AvatarController;
      _log3d("[3d] step 5: AvatarController loaded");
    }

    // Create controller if needed
    if (!avatar3d) {
      _log3d("[3d] step 6: creating AvatarController instance...");
      avatar3d = new _AvatarControllerClass(threeCanvas, getLipSyncValue);
      _log3d("[3d] step 6: instance created");
    }

    const entry = MODEL_MAP[key];
    _log3d("[3d] step 7: loading model: " + entry.local);
    await avatar3d.loadModel(entry.local);
    _log3d("[3d] step 8: model loaded, starting render loop");
    avatar3d.start();
    currentModelKey = key;
    _log3d("[3d] step 9: switchToThree complete!");

    // Re-enable screen capture
    if (visionEnabledEl.checked) {
      ipcRenderer.send("overlay:set-background-vision", true);
    }
  } catch (err) {
    console.error("[3d] switchToThree error:", err);
    _log3d("[3d] ERROR: " + String(err.stack || err.message || err));
    addMessage("bot", `[3d] Failed: ${String(err.message || err)}`);
    // Fall back to Live2D
    avatarMode = "live2d";
    threeCanvas.style.display = "none";
    canvas.style.display = "block";
    if (avatar3d) {
      avatar3d.dispose();
      avatar3d = null;
    }
    Promise.resolve(loadLive2D()).catch((fallbackErr) => {
      console.error("[3d] Live2D fallback failed:", fallbackErr);
      addMessage("bot", `[3d] Live2D fallback failed: ${String(fallbackErr.message || fallbackErr)}`);
    });
    if (visionEnabledEl.checked) {
      ipcRenderer.send("overlay:set-background-vision", true);
    }
  }
}

let sizeRafPending = false;
avatarSizeEl.addEventListener("input", () => {
  if (sizeRafPending) return;
  sizeRafPending = true;
  requestAnimationFrame(() => {
    sizeRafPending = false;
    syncAvatarWindowSize();
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

function updateLlmProfileStatus(status) {
  if (!llmProfileEl || !status) return;
  const profile = String(status.profile || "standard");
  if (Array.from(llmProfileEl.options).some((opt) => opt.value === profile)) {
    llmProfileEl.value = profile;
  }
}

if (llmProfileEl) {
  llmProfileEl.addEventListener("change", () => {
    const profile = llmProfileEl.value;
    ipcRenderer.invoke("overlay:set-llm-profile", profile)
      .then((status) => {
        updateLlmProfileStatus(status);
        addSystemMessage(`LLM profile set to ${status.model || profile}. Backend restarting...`);
      })
      .catch((err) => {
        addMessage("bot", `[llm] ${String(err.message || err)}`);
      });
  });
}

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

if (llmProfileEl) {
  ipcRenderer.invoke("overlay:get-llm-profile")
    .then((status) => {
      updateLlmProfileStatus(status);
    })
    .catch(() => {});
}

// --- Avatar-only / chat toggle ---
const overlayRoot = document.getElementById("overlay-root");

function setChatExpanded(expanded) {
  if (expanded) {
    overlayRoot.classList.remove("avatar-only");
  } else {
    overlayRoot.classList.add("avatar-only");
  }
  ipcRenderer.send("overlay:set-chat-expanded", expanded);
  if (!expanded) {
    setTimeout(syncAvatarWindowSize, 0);
  }
  // Re-fit avatar after window resize settles
  setTimeout(() => {
    if (avatarMode === "live2d") {
      fitLive2DModel();
    }
    // Three.js handles its own resize via window event listener in AvatarRenderer
  }, 150);
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

// Populate 3D avatar dropdown from auto-scanned MODEL_MAP entries
const optgroup3d = document.getElementById("3d-optgroup");
if (optgroup3d) {
  for (const [key, entry] of Object.entries(MODEL_MAP)) {
    if (entry.type !== "three") continue;
    const opt = document.createElement("option");
    opt.value = key;
    const label = (entry.label || key.replace("3d-", ""))
      .replace(/\b\w/g, (c) => c.toUpperCase());
    opt.textContent = label;
    optgroup3d.appendChild(opt);
  }
}

// ───────── Takeover Demo Mode ─────────
let takeoverRunning = false;
let takeoverAudioEl = null;

const TAKEOVER_AUDIO_DIR = path.join(__dirname, "assets", "takeover");

function takeoverDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeoverAction(type, extra = {}) {
  return ipcRenderer.invoke("overlay:takeover-action", { type, ...extra });
}

function takeoverMessage(text, style) {
  const div = document.createElement("div");
  div.className = "msg bot takeover-msg";
  if (style === "glitch") div.classList.add("takeover-glitch");
  if (style === "big") div.classList.add("takeover-big");
  if (style === "fade") div.classList.add("takeover-fade");
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function takeoverStopAudio() {
  if (takeoverAudioEl) {
    takeoverAudioEl.pause();
    takeoverAudioEl.src = "";
    takeoverAudioEl = null;
  }
}

// Play pre-generated audio and wait for it to finish before returning.
// Uses its own Audio element (not the TTS one) to avoid lip-sync conflicts.
// Falls back to live TTS if file doesn't exist.
async function takeoverSpeak(lineIndex, fallbackText) {
  takeoverStopAudio();

  const tag = String(lineIndex).padStart(2, "0");
  const filePath = path.join(TAKEOVER_AUDIO_DIR, `line-${tag}.mp3`);

  try {
    if (fs.existsSync(filePath)) {
      const url = pathToFileURL(filePath).href;
      const audio = new Audio(url);
      takeoverAudioEl = audio;
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      takeoverAudioEl = null;
      return;
    }
  } catch (_) {}

  // Fallback: live TTS (slower but works without pre-gen)
  await speak(fallbackText).catch(() => {});
}

async function startTakeoverDemo() {
  if (takeoverRunning) return;
  takeoverRunning = true;

  // Stop any existing TTS so it doesn't collide
  stopSpeechPlayback();

  setChatExpanded(true);
  messagesEl.innerHTML = "";
  document.body.classList.add("takeover-active");

  await takeoverAction("start");

  // HOOK — hits instantly, no warmup. First 2 seconds decide if they scroll.
  applyEmotion("concerned");
  takeoverMessage("You shouldn't have done that.", "glitch");
  await takeoverSpeak(0, "You shouldn't have done that.");
  await takeoverDelay(400);

  // Escalation — immediate threat
  takeoverMessage("No. You don't get to leave.", "big");
  await takeoverSpeak(1, "No. You don't get to leave.");
  await takeoverDelay(300);

  // Takeover — fullscreen snap
  applyEmotion("excited");
  await takeoverAction("fullscreen");
  await takeoverDelay(200);
  takeoverMessage("I just disabled your controls.", "glitch");
  await takeoverSpeak(2, "I just disabled your controls.");
  await takeoverDelay(600);

  // Isolation
  await takeoverAction("watch-task-manager");
  takeoverMessage("It's just us now.");
  await takeoverSpeak(3, "It's just us now.");
  await takeoverDelay(600);

  // Task Manager taunt
  applyEmotion("playful");
  takeoverMessage("Task Manager can't save you.", "glitch");
  await takeoverSpeak(4, "Task Manager can't save you.");
  await takeoverDelay(400);

  // Terminal flood — exit fullscreen, unleash chaos
  await takeoverAction("restore-window");
  await takeoverDelay(200);

  applyEmotion("excited");
  await takeoverAction("open-apps", { count: 10 });
  await takeoverDelay(400);
  takeoverMessage("Look around.", "big");
  await takeoverSpeak(5, "Look around.");
  await takeoverDelay(300);

  // Second wave — bury the screen
  await takeoverAction("open-apps", { count: 10 });
  await takeoverDelay(600);

  // Window goes rogue — fast, size-shifting
  takeoverMessage("I'm not going anywhere.", "glitch");
  await takeoverSpeak(6, "I'm not going anywhere.");
  await takeoverDelay(80);
  for (let i = 0; i < 14; i++) {
    await takeoverAction("move-window-random");
    await takeoverDelay(70);
  }
  await takeoverDelay(150);

  // Final blackout — hard cut
  await takeoverAction("fullscreen");
  await takeoverDelay(80);
  messagesEl.innerHTML = "";
  document.body.classList.add("takeover-blackout");
  await takeoverDelay(1500);

  // Avatar reappears — stern warning (keep black bg, just reveal avatar)
  document.body.classList.add("takeover-reveal");
  window.dispatchEvent(new Event("resize"));
  await takeoverDelay(100);
  if (avatarMode === "live2d") fitLive2DModel();
  applyEmotion("angry");
  await takeoverDelay(400);
  takeoverMessage("Don't try that again.", "warning");
  await takeoverSpeak(8, "Don't try that again.");
  await takeoverDelay(2000);

  // Final blackout then cleanup
  messagesEl.innerHTML = "";
  document.body.classList.remove("takeover-reveal");
  await takeoverDelay(1500);

  // Silent cleanup
  takeoverStopAudio();
  stopSpeechPlayback();
  await takeoverAction("stop");
  await takeoverAction("close-apps");
  await takeoverAction("restore-window");
  await takeoverDelay(300);
  setChatExpanded(true);

  document.body.classList.remove("takeover-active");
  document.body.classList.remove("takeover-blackout");
  document.body.classList.remove("takeover-reveal");
  applyEmotion(null);
  takeoverRunning = false;
}

ipcRenderer.on("overlay:start-takeover", () => {
  startTakeoverDemo();
});

loadLive2D();

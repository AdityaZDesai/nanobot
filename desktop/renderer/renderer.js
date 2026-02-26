const { ipcRenderer } = require("electron");
const PIXI = require("pixi.js");
const path = require("path");
const { pathToFileURL } = require("url");

globalThis.PIXI = PIXI;

const localModelPath = require.resolve("live2d-widget-model-shizuku/assets/shizuku.model.json");
const cubism2RuntimePath = path.join(__dirname, "vendor", "live2d.min.js");

const modelCandidates = [
  pathToFileURL(localModelPath).href,
  "https://unpkg.com/live2d-widget-model-shizuku@1.0.5/assets/shizuku.model.json",
];

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
const canvas = document.getElementById("live2d-canvas");

let ttsEnabled = true;
let model = null;
let currentAudio = null;
let currentAudioUrl = null;
let mediaRecorder = null;
let mediaStream = null;
let isRecording = false;
let recorderChunks = [];

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

async function loadLive2D() {
  try {
    await ensureCubism2Runtime();
  } catch (err) {
    addMessage("bot", `Failed to initialize Live2D runtime: ${String(err.message || err)}`);
    return;
  }

  const { Live2DModel } = require("pixi-live2d-display/cubism2");

  const app = new PIXI.Application({
    view: canvas,
    resizeTo: canvas.parentElement,
    transparent: true,
    antialias: true,
  });

  for (const url of modelCandidates) {
    try {
      model = await Live2DModel.from(url, {
        autoInteract: true,
      });
      break;
    } catch (err) {
      addMessage("bot", `[live2d] Failed model candidate: ${url}`);
      addMessage("bot", `[live2d] ${String(err.message || err)}`);
    }
  }

  if (!model) {
    addMessage("bot", "Failed to load Live2D model from local assets or fallback URLs.");
    return;
  }

  app.stage.addChild(model);

  function fitModel() {
    const { width, height } = app.screen;
    const scale = Math.min(width / model.width, height / model.height) * 0.9;
    model.scale.set(scale);
    model.x = width * 0.5;
    model.y = height * 0.96;
    model.anchor.set(0.5, 1);
  }

  fitModel();
  window.addEventListener("resize", fitModel);
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

voiceInBtn.addEventListener("click", () => {
  if (isRecording) {
    stopVoiceRecording()
      .then(async (result) => {
        if (!result || !result.blob || result.blob.size === 0) {
          return;
        }

        voiceInBtn.textContent = "Transcribing";
        const transcription = await transcribeVoice(result.blob, result.mimeType);
        if (transcription.text) {
          inputEl.value = transcription.text;
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

loadLive2D();

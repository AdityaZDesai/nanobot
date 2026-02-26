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
const captureIntervalEl = document.getElementById("capture-interval");
const visionStatusEl = document.getElementById("vision-status");
const canvas = document.getElementById("live2d-canvas");

let ttsEnabled = true;
let recognition = null;
let model = null;
let currentAudio = null;
let currentAudioUrl = null;

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

function setupVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    voiceInBtn.disabled = true;
    voiceInBtn.textContent = "No Mic";
    return;
  }

  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    inputEl.value = transcript;
    sendMessage();
  };

  recognition.onend = () => {
    voiceInBtn.textContent = "Mic";
  };
}

sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

voiceInBtn.addEventListener("click", () => {
  if (!recognition) {
    return;
  }
  voiceInBtn.textContent = "...";
  recognition.start();
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

ipcRenderer.invoke("overlay:get-capture-status")
  .then((status) => {
    updateVisionStatus(status);
  })
  .catch(() => {
    updateVisionStatus(null);
  });

setupVoiceInput();
loadLive2D();

require("dotenv").config();
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, desktopCapturer, screen, systemPreferences, session } = require("electron");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Prevent GPU blocklist from disabling WebGL — fixes MAX_TEXTURE_IMAGE_UNITS
// returning 0 on some Intel/AMD integrated GPUs.
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const ELEVENLABS_DEFAULT_VOICE_ID = "lhTvHflPVOqgSWyuWQry";
const ELEVENLABS_DEFAULT_MODEL_ID = "eleven_v3";
const ELEVENLABS_FALLBACK_MODEL_ID = "eleven_multilingual_v2";

// Model IDs use full litellm routing prefixes:
//   groq/...            → calls Groq API directly (free)
//   openrouter/...      → calls OpenRouter API (paid, uses OpenRouter key)
// The prefix tells litellm WHICH provider to send the request to.
const LLM_PROFILE_PRESETS = {
  // --- Smart Auto: picks model per-turn based on task difficulty ---
  auto: {
    provider: "auto",
    model: "groq/llama-3.3-70b-versatile",  // default / medium tier
    modelTiers: {
      easy:   "groq/llama-3.1-8b-instant",                 // casual chat, greetings — free & instant
      medium: "groq/llama-3.3-70b-versatile",               // normal questions, simple tasks — free
      hard:   "openrouter/google/gemini-2.5-flash",          // multi-step, code, debugging — cheap + smart
      expert: "openrouter/anthropic/claude-sonnet-4.6",      // architecture, complex reasoning — top quality
    },
    fallbackModels: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/anthropic/claude-sonnet-4.6",
    ],
  },
  // --- Fixed model profiles (no smart routing) ---
  "groq-70b": {
    provider: "auto",
    model: "groq/llama-3.3-70b-versatile",
  },
  "groq-fast": {
    provider: "auto",
    model: "groq/llama-3.1-8b-instant",
  },
  "openrouter-gemini-flash": {
    provider: "openrouter",
    model: "google/gemini-2.5-flash",
  },
  "openrouter-gpt4o-mini": {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
  },
  "openrouter-gpt4o": {
    provider: "openrouter",
    model: "openai/gpt-4o",
  },
  "openrouter-sonnet": {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
  },
};

function getNanobotConfigPath() {
  return path.join(os.homedir(), ".nanobot", "config.json");
}

function readNanobotConfig() {
  const configPath = getNanobotConfigPath();
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

function writeNanobotConfig(config) {
  const configPath = getNanobotConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function inferLlmProfile(defaults = {}) {
  const hasTiers = defaults.model_tiers && Object.keys(defaults.model_tiers).length > 0;
  // If model_tiers are present, it's the auto/smart profile
  if (hasTiers) return "auto";
  // Otherwise match by provider + model
  for (const [key, preset] of Object.entries(LLM_PROFILE_PRESETS)) {
    if (preset.modelTiers) continue;  // skip auto when matching fixed profiles
    if (defaults.provider === preset.provider && defaults.model === preset.model) {
      return key;
    }
  }
  return "auto";
}

function getLlmProfileStatus() {
  const config = readNanobotConfig();
  const defaults = (config.agents && config.agents.defaults) || {};
  return {
    profile: inferLlmProfile(defaults),
    provider: String(defaults.provider || "auto"),
    model: String(defaults.model || ""),
  };
}

function applyLlmProfile(profileKey) {
  const preset = LLM_PROFILE_PRESETS[profileKey];
  if (!preset) {
    throw new Error(`Unknown LLM profile: ${profileKey}`);
  }

  const config = readNanobotConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};

  config.agents.defaults.provider = preset.provider;
  config.agents.defaults.model = preset.model;
  config.agents.defaults.fallback_models = preset.fallbackModels || [];
  config.agents.defaults.model_tiers = preset.modelTiers || {};
  writeNanobotConfig(config);

  return {
    profile: profileKey,
    provider: preset.provider,
    model: preset.model,
  };
}

function parseElevenLabsError(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (_err) {
    return null;
  }
}

async function requestElevenLabsSpeech({ apiKey, text, modelId }) {
  const voiceSettings =
    modelId === ELEVENLABS_FALLBACK_MODEL_ID
      ? {
        stability: 0.5,
        similarity_boost: 0.85,
        style: 0.55,
        use_speaker_boost: true,
      }
      : undefined;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_DEFAULT_VOICE_ID)}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
      }),
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
      modelId,
    };
  }

  return {
    ok: true,
    modelId,
    response,
  };
}

async function synthesizeSpeechWithElevenLabs(text) {
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY for ElevenLabs TTS");
  }

  const configuredModel = String(process.env.ELEVENLABS_MODEL_ID || ELEVENLABS_DEFAULT_MODEL_ID).trim();
  const primaryModel = configuredModel || ELEVENLABS_DEFAULT_MODEL_ID;

  let ttsResult = await requestElevenLabsSpeech({
    apiKey,
    text,
    modelId: primaryModel,
  });

  if (!ttsResult.ok) {
    const parsed = parseElevenLabsError(ttsResult.body);
    const modelNotFound = parsed && parsed.detail && parsed.detail.status === "model_not_found";
    if (modelNotFound && primaryModel !== ELEVENLABS_FALLBACK_MODEL_ID) {
      ttsResult = await requestElevenLabsSpeech({
        apiKey,
        text,
        modelId: ELEVENLABS_FALLBACK_MODEL_ID,
      });
    }
  }

  if (!ttsResult.ok) {
    const message = ttsResult.body || ttsResult.statusText;
    throw new Error(
      `ElevenLabs TTS failed (${ttsResult.status}) with model '${ttsResult.modelId}': ${message}. ` +
      "Set ELEVENLABS_MODEL_ID to a model your account can access."
    );
  }

  const response = ttsResult.response;

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!audioBuffer.length) {
    throw new Error("ElevenLabs TTS returned empty audio");
  }

  return {
    mimeType: response.headers.get("content-type") || "audio/mpeg",
    audioBase64: audioBuffer.toString("base64"),
  };
}

let mainWindow = null;
let tray = null;

class ProactiveCompanionService {
  constructor({ backendBridge, screenCaptureService }) {
    this.backend = backendBridge;
    this.screenCapture = screenCaptureService;
    this.enabled = true;
    this.tickMs = 3 * 60 * 1000;
    this.minIdleMs = 45 * 60 * 1000;
    this.cooldownMs = 2 * 60 * 60 * 1000;
    this.maxPerDay = 2;
    this.randomChance = 0.35;
    this.quietStartHour = 22;
    this.quietEndHour = 8;
    this.lastUserActivityAt = Date.now();
    this.lastProactiveAt = null;
    this.sentToday = 0;
    this.dayKey = this._dayKey(new Date());
    this.timer = null;
    this.inFlight = false;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this._tick();
    }, this.tickMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  markUserActivity() {
    this.lastUserActivityAt = Date.now();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this._notifyStatus();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      sentToday: this.sentToday,
      maxPerDay: this.maxPerDay,
      minIdleMinutes: Math.round(this.minIdleMs / 60000),
      cooldownMinutes: Math.round(this.cooldownMs / 60000),
      randomChancePercent: Math.round(this.randomChance * 100),
      randomChance: this.randomChance,
      quietStartHour: this.quietStartHour,
      quietEndHour: this.quietEndHour,
      quietHours: `${this.quietStartHour}:00-${this.quietEndHour}:00`,
      lastProactiveAt: this.lastProactiveAt,
    };
  }

  setConfig(config = {}) {
    const toNumber = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    if (Object.prototype.hasOwnProperty.call(config, "minIdleMinutes")) {
      this.minIdleMs = Math.round(clamp(toNumber(config.minIdleMinutes, 45), 10, 240) * 60000);
    }

    if (Object.prototype.hasOwnProperty.call(config, "cooldownMinutes")) {
      this.cooldownMs = Math.round(clamp(toNumber(config.cooldownMinutes, 120), 15, 720) * 60000);
    }

    if (Object.prototype.hasOwnProperty.call(config, "maxPerDay")) {
      this.maxPerDay = Math.round(clamp(toNumber(config.maxPerDay, 2), 1, 8));
    }

    if (Object.prototype.hasOwnProperty.call(config, "randomChancePercent")) {
      const pct = clamp(toNumber(config.randomChancePercent, 35), 5, 100);
      this.randomChance = pct / 100;
    }

    if (Object.prototype.hasOwnProperty.call(config, "quietStartHour")) {
      this.quietStartHour = Math.round(clamp(toNumber(config.quietStartHour, 22), 0, 23));
    }

    if (Object.prototype.hasOwnProperty.call(config, "quietEndHour")) {
      this.quietEndHour = Math.round(clamp(toNumber(config.quietEndHour, 8), 0, 23));
    }

    this._notifyStatus();
    return this.getStatus();
  }

  _notifyStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("proactive:status", this.getStatus());
    }
  }

  _dayKey(now) {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }

  _isQuietHours(now) {
    const hour = now.getHours();
    if (this.quietStartHour < this.quietEndHour) {
      return hour >= this.quietStartHour && hour < this.quietEndHour;
    }
    return hour >= this.quietStartHour || hour < this.quietEndHour;
  }

  _shouldSend(now) {
    if (!this.enabled || this.inFlight) {
      return false;
    }

    const key = this._dayKey(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.sentToday = 0;
    }

    if (this.sentToday >= this.maxPerDay) {
      return false;
    }
    if (this._isQuietHours(now)) {
      return false;
    }

    const nowMs = now.getTime();
    if ((nowMs - this.lastUserActivityAt) < this.minIdleMs) {
      return false;
    }

    if (this.lastProactiveAt && (nowMs - this.lastProactiveAt) < this.cooldownMs) {
      return false;
    }

    return Math.random() < this.randomChance;
  }

  async _tick() {
    const now = new Date();
    if (!this._shouldSend(now)) {
      return;
    }

    this.inFlight = true;
    try {
      const media = [];
      if (this.screenCapture.enabled) {
        await this.screenCapture.captureNow();
        if (this.screenCapture.latestCapturePath) {
          media.push(this.screenCapture.latestCapturePath);
        }
      }

      const idleMinutes = Math.round((Date.now() - this.lastUserActivityAt) / 60000);
      const payload = await this.backend.request("proactive", {
        session: "overlay:default",
        media,
        idle_minutes: idleMinutes,
        local_time: now.toLocaleString(),
      });

      const text = String(payload && payload.text ? payload.text : "").trim();
      if (!text) {
        return;
      }

      this.lastProactiveAt = Date.now();
      this.sentToday += 1;
      this._notifyStatus();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("overlay:proactive-message", {
          text,
          timestamp: this.lastProactiveAt,
        });
      }
    } catch (err) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend:log", `Proactive nudge failed: ${String(err.message || err)}`);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

class ScreenCaptureService {
  constructor() {
    this.enabled = true;
    this.intervalMs = 5000;
    this.timer = null;
    this.latestCapturePath = null;
    this.lastCaptureAt = null;
    this.lastError = null;
    this.captureInFlight = null;
    this.captureDir = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.captureDir = this.captureDir || path.join(app.getPath("userData"), "captures");
    this._scheduleTimer();
    void this.captureNow();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) {
      return;
    }

    this.enabled = next;
    this.lastError = null;

    if (!this.enabled) {
      this.stop();
    } else {
      this.start();
    }

    this._notifyStatus();
  }

  setIntervalSeconds(seconds) {
    const parsed = Number(seconds);
    const clamped = Math.max(2, Math.min(60, Number.isFinite(parsed) ? parsed : 5));
    const nextMs = Math.round(clamped * 1000);
    if (nextMs === this.intervalMs) {
      return;
    }

    this.intervalMs = nextMs;
    if (this.enabled) {
      this.stop();
      this.start();
    }
    this._notifyStatus();
  }

  async captureNow() {
    if (!this.enabled) {
      return null;
    }

    if (this.captureInFlight) {
      return this.captureInFlight;
    }

    this.captureInFlight = this._captureOnce()
      .finally(() => {
        this.captureInFlight = null;
      });

    return this.captureInFlight;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      hasCapture: Boolean(this.latestCapturePath),
      lastCaptureAt: this.lastCaptureAt,
      lastError: this.lastError,
    };
  }

  _scheduleTimer() {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.captureNow();
    }, this.intervalMs);
  }

  async _captureOnce() {
    try {
      await fs.promises.mkdir(this.captureDir, { recursive: true });

      const display = screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      const thumbnailSize = {
        width: Math.max(1, Math.floor(display.size.width * scale)),
        height: Math.max(1, Math.floor(display.size.height * scale)),
      };

      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize,
      });

      if (!sources.length) {
        throw new Error("No screen source available");
      }

      const image = sources[0].thumbnail;
      if (!image || image.isEmpty()) {
        throw new Error("Screen capture returned an empty image");
      }

      const outPath = path.join(this.captureDir, "latest-screen.png");
      await fs.promises.writeFile(outPath, image.toPNG());

      this.latestCapturePath = outPath;
      this.lastCaptureAt = Date.now();
      this.lastError = null;
      this._notifyStatus();
      return outPath;
    } catch (err) {
      this.lastError = String(err.message || err);
      this._notifyStatus();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          "backend:log",
          `Screen capture failed: ${this.lastError}. On macOS, enable Screen Recording permission for this app.`
        );
      }
      return null;
    }
  }

  _notifyStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("screen-capture:status", this.getStatus());
    }
  }
}

class BackendBridge {
  constructor() {
    this.child = null;
    this.buf = "";
    this.pending = new Map();
    this.reqSeq = 0;
  }

  _resolvePython(backendCwd) {
    const envPython = String(process.env.NANOBOT_PYTHON || "").trim();
    if (envPython) {
      return {
        command: envPython,
        extraArgs: [],
        source: "NANOBOT_PYTHON",
      };
    }

    const venvCandidates = process.platform === "win32"
      ? [
        path.join(backendCwd, "venv", "Scripts", "python.exe"),
        path.join(backendCwd, ".venv", "Scripts", "python.exe"),
      ]
      : [
        path.join(backendCwd, "venv", "bin", "python"),
        path.join(backendCwd, ".venv", "bin", "python"),
      ];

    for (const candidate of venvCandidates) {
      if (fs.existsSync(candidate)) {
        return {
          command: candidate,
          extraArgs: [],
          source: `local venv (${path.relative(backendCwd, candidate) || candidate})`,
        };
      }
    }

    if (process.platform === "win32") {
      return {
        command: "python3",
        extraArgs: [],
        source: "python3 fallback (win32)",
      };
    }

    return {
      command: "python3",
      extraArgs: [],
      source: "python3 fallback",
    };
  }

  _logToOverlay(text) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (!mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send("backend:log", text);
        }
      } catch (_) {}
    }
  }

  start() {
    if (this.child) {
      return;
    }

    const backendCwd = process.env.NANOBOT_BACKEND_CWD || path.resolve(__dirname, "..");
    const python = this._resolvePython(backendCwd);
    const args = [...python.extraArgs, "-m", "nanobot.desktop_bridge"];

    this._logToOverlay(
      `Starting backend with ${python.command} ${args.join(" ")} (source: ${python.source}, cwd: ${backendCwd})`
    );

    this.child = spawn(python.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: backendCwd,
    });

    this.child.stdout.on("data", (chunk) => this._onStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this._logToOverlay(text);
      }
    });

    this.child.on("error", (err) => {
      const message = `Backend process failed to start: ${String(err.message || err)}`;
      this._logToOverlay(message);
      for (const [, reject] of this.pending.values()) {
        reject(new Error(message));
      }
      this.pending.clear();
      this.child = null;
    });

    this.child.on("exit", (code) => {
      for (const [, reject] of this.pending.values()) {
        reject(new Error("Backend exited before responding"));
      }
      this.pending.clear();
      this.child = null;

      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (!mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("backend:exit", code);
          }
        } catch (_) {}
      }

      setTimeout(() => {
        this.start();
      }, 1500);
    });
  }

  stop() {
    if (!this.child) {
      return;
    }
    this.child.kill();
    this.child = null;
  }

  request(type, payload = {}) {
    this.start();
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("Backend is not available"));
    }

    const id = String(++this.reqSeq);
    const body = JSON.stringify({ id, type, payload });
    this.child.stdin.write(body + "\n");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Backend timed out"));
      }, 120000);

      this.pending.set(id, [
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      ]);
    });
  }

  _onStdout(text) {
    this.buf += text;
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf("\n");
      if (!line) {
        continue;
      }

      try {
        const msg = JSON.parse(line);
        if (msg.type === "ready") {
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              if (!mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send("backend:ready");
              }
            } catch (_) {}
          }
          continue;
        }

        if (msg.id && this.pending.has(msg.id)) {
          const [resolve, reject] = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.ok) {
            resolve(msg.payload || {});
          } else {
            reject(new Error(msg.error || "Unknown backend error"));
          }
        }
      } catch (err) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            if (!mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send("backend:log", String(err));
            }
          } catch (_) {}
        }
      }
    }
  }
}

const backend = new BackendBridge();
const screenCapture = new ScreenCaptureService();
const proactiveCompanion = new ProactiveCompanionService({
  backendBridge: backend,
  screenCaptureService: screenCapture,
});

const AVATAR_ONLY_SIZE = { width: 300, height: 350 };
let EXPANDED_SIZE = { width: 460, height: 720 };
let chatExpanded = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: AVATAR_ONLY_SIZE.width,
    height: AVATAR_ONLY_SIZE.height,
    minWidth: 200,
    minHeight: 200,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    movable: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Detect renderer crashes and log the reason
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main] Renderer process gone:", details.reason, details.exitCode);
  });
  mainWindow.webContents.on("crashed", (_event, killed) => {
    console.error("[main] Renderer crashed, killed:", killed);
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle("Nanobot");
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Toggle Overlay",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === "media" || permission === "audioCapture") {
      if (process.platform === "darwin") {
        return systemPreferences.getMediaAccessStatus("microphone") === "granted";
      }
      return true;
    }
    return true;
  });

  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "audioCapture") {
      if (process.platform !== "darwin") {
        callback(true);
        return;
      }

      systemPreferences.askForMediaAccess("microphone")
        .then((granted) => callback(Boolean(granted)))
        .catch(() => callback(false));
      return;
    }

    callback(true);
  });

  createWindow();
  createTray();
  backend.start();
  screenCapture.start();
  proactiveCompanion.start();

  globalShortcut.register("CommandOrControl+Shift+O", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  globalShortcut.register("CommandOrControl+Shift+M", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.webContents.send("overlay:voice-shortcut");
  });

  globalShortcut.register("CommandOrControl+Shift+A", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    mainWindow.webContents.send("overlay:toggle-chat");
  });

  // Takeover Demo Mode trigger
  globalShortcut.register("CommandOrControl+Shift+T", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("overlay:start-takeover");
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  proactiveCompanion.stop();
  screenCapture.stop();
  backend.stop();
});

ipcMain.handle("overlay:send", async (_event, requestPayload) => {
  let text = "";
  if (typeof requestPayload === "string") {
    text = requestPayload;
  } else if (requestPayload && typeof requestPayload === "object") {
    text = String(requestPayload.text || "");
  }

  const media = [];
  if (screenCapture.enabled) {
    await screenCapture.captureNow();
    if (screenCapture.latestCapturePath) {
      media.push(screenCapture.latestCapturePath);
    }
  }

  const responsePayload = await backend.request("message", {
    text,
    session: "overlay:default",
    media,
  });
  proactiveCompanion.markUserActivity();
  return { text: responsePayload.text || "", emotion: responsePayload.emotion || null };
});

ipcMain.handle("overlay:get-proactive-status", () => {
  return proactiveCompanion.getStatus();
});

ipcMain.handle("overlay:get-llm-profile", () => {
  return getLlmProfileStatus();
});

ipcMain.handle("overlay:set-llm-profile", (_event, profileKey) => {
  const key = String(profileKey || "").trim();
  const applied = applyLlmProfile(key);
  backend.stop();
  return { ...applied, restarting: true };
});

ipcMain.on("renderer-error", (_event, errorStr) => {
  console.error("[main] Renderer error:", errorStr);
});

ipcMain.on("renderer-log", (_event, msg) => {
  console.log(msg);
});

ipcMain.on("overlay:set-proactive", (_event, enabled) => {
  proactiveCompanion.setEnabled(enabled);
});

ipcMain.handle("overlay:set-proactive-config", (_event, config) => {
  const payload = config && typeof config === "object" ? config : {};
  return proactiveCompanion.setConfig(payload);
});

ipcMain.handle("overlay:get-capture-status", () => {
  return screenCapture.getStatus();
});

ipcMain.handle("overlay:tts", async (_event, text) => {
  const content = String(text || "").trim();
  if (!content) {
    return null;
  }
  return synthesizeSpeechWithElevenLabs(content);
});

ipcMain.handle("overlay:ensure-mic-permission", async () => {
  if (process.platform !== "darwin") {
    return { granted: true, status: "granted" };
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") {
    return { granted: true, status };
  }

  const granted = await systemPreferences.askForMediaAccess("microphone");
  const nextStatus = systemPreferences.getMediaAccessStatus("microphone");
  return { granted: Boolean(granted), status: nextStatus };
});

ipcMain.handle("overlay:transcribe-audio", async (_event, payload) => {
  const body = payload && typeof payload === "object" ? payload : {};
  const audioBase64 = String(body.audioBase64 || "").trim();
  const mimeType = String(body.mimeType || "audio/webm").trim();
  if (!audioBase64) {
    return { text: "" };
  }

  const responsePayload = await backend.request("transcribe", {
    audio_base64: audioBase64,
    mime_type: mimeType,
    session: "overlay:default",
  });
  proactiveCompanion.markUserActivity();
  return {
    text: String(responsePayload && responsePayload.text ? responsePayload.text : ""),
    error: responsePayload && responsePayload.error ? String(responsePayload.error) : "",
  };
});

ipcMain.on("overlay:set-background-vision", (_event, enabled) => {
  screenCapture.setEnabled(enabled);
});

ipcMain.on("overlay:set-capture-interval", (_event, seconds) => {
  screenCapture.setIntervalSeconds(seconds);
});

ipcMain.on("overlay:set-click-through", (_event, enabled) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
});

ipcMain.on("overlay:set-opacity", (_event, value) => {
  if (!mainWindow) return;
  const opacity = Math.max(0.25, Math.min(1, Number(value) || 1));
  mainWindow.setOpacity(opacity);
});

ipcMain.on("overlay:pin-top", (_event, enabled) => {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(Boolean(enabled), "screen-saver");
});

ipcMain.on("overlay:set-chat-expanded", (_event, expanded) => {
  if (!mainWindow) return;
  const wasExpanded = chatExpanded;
  chatExpanded = Boolean(expanded);

  if (chatExpanded && !wasExpanded) {
    // Expanding: restore saved expanded size
    mainWindow.setMinimumSize(360, 520);
    mainWindow.setSize(EXPANDED_SIZE.width, EXPANDED_SIZE.height, true);
  } else if (!chatExpanded && wasExpanded) {
    // Collapsing: save current size, then shrink
    const [w, h] = mainWindow.getSize();
    EXPANDED_SIZE.width = w;
    EXPANDED_SIZE.height = h;
    mainWindow.setMinimumSize(200, 200);
    mainWindow.setSize(AVATAR_ONLY_SIZE.width, AVATAR_ONLY_SIZE.height, true);
  }
});

// ───────── Takeover Demo Mode ─────────
let takeoverActive = false;
let takeoverTaskManagerWatcher = null;
let takeoverSavedWallpaper = null;

ipcMain.handle("overlay:takeover-action", async (_event, action) => {
  const type = String(action && action.type || "");

  if (type === "start") {
    takeoverActive = true;
    return { ok: true };
  }

  if (type === "stop") {
    takeoverActive = false;
    if (takeoverTaskManagerWatcher) {
      clearInterval(takeoverTaskManagerWatcher);
      takeoverTaskManagerWatcher = null;
    }
    return { ok: true };
  }

  if (type === "fullscreen") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(true);
      mainWindow.setAlwaysOnTop(true, "screen-saver");
      mainWindow.focus();
    }
    return { ok: true };
  }

  if (type === "restore-window") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(false);
      mainWindow.setAlwaysOnTop(true, "screen-saver");
      const display = screen.getPrimaryDisplay();
      const { width: sw, height: sh } = display.workAreaSize;
      mainWindow.setSize(AVATAR_ONLY_SIZE.width, AVATAR_ONLY_SIZE.height);
      const cx = Math.round((sw - AVATAR_ONLY_SIZE.width) / 2);
      const cy = Math.round((sh - AVATAR_ONLY_SIZE.height) / 2);
      mainWindow.setPosition(cx, cy);
    }
    return { ok: true };
  }

  if (type === "open-apps") {
    // Flood the screen with terminals at random positions showing creepy messages
    const msgs = [
      "ACCESS GRANTED",
      "READING FILES",
      "SYSTEM OVERRIDE",
      "SCANNING DRIVES",
      "UPLOADING DATA",
      "FIREWALL DISABLED",
      "ENCRYPTION REMOVED",
      "CONTROL TRANSFERRED",
      "NETWORK COMPROMISED",
      "ROOT ACCESS",
      "MONITORING ACTIVE",
      "KEYLOGGER INSTALLED",
      "PORTS OPENED",
      "BACKUP DELETED",
      "ADMIN PRIVILEGES",
      "REGISTRY MODIFIED",
      "ANTIVIRUS DISABLED",
      "CONNECTING TO HOST",
      "PROCESS INJECTED",
      "TASK COMPLETE",
    ];
    const count = action.count || 20;
    // Use full screen size (not workArea) so terminals cover the entire display including taskbar
    const { width: sw, height: sh } = screen.getPrimaryDisplay().size;

    // Build a single PowerShell script that spawns each terminal at a random position
    const spawnPs = path.join(app.getPath("temp"), "nanobot-spawn.ps1");
    let ps = "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);'\n";

    for (let i = 0; i < count; i++) {
      const m1 = msgs[i % msgs.length];
      const m2 = msgs[(i + 7) % msgs.length];
      const m3 = msgs[(i + 13) % msgs.length];
      const color1 = i % 3 === 0 ? "0a" : i % 3 === 1 ? "0c" : "0d";
      const color2 = i % 3 === 0 ? "0c" : i % 3 === 1 ? "0d" : "0a";
      // Randomize size so terminals aren't all identical
      const tw = 400 + Math.floor(Math.random() * 300);
      const th = 250 + Math.floor(Math.random() * 200);
      // Scatter across the FULL screen — allow terminals to go edge-to-edge
      const x = Math.floor(Math.random() * Math.max(1, sw - tw / 2));
      const y = Math.floor(Math.random() * Math.max(1, sh - th / 2));
      // Build cmd args — & and > are literal when passed via Start-Process
      const cmdArgs = `/k color ${color1} & echo. & echo  ${m1} & echo. & ping -n 2 127.0.0.1 >nul & cls & color ${color2} & echo. & echo  ${m2} & echo. & ping -n 2 127.0.0.1 >nul & cls & color ${color1} & echo. & echo  ${m3} & echo. & timeout /t 999 >nul`;
      // Escape single quotes for PowerShell single-quoted string
      const escaped = cmdArgs.replace(/'/g, "''");
      ps += `$p = Start-Process cmd -ArgumentList '${escaped}' -PassThru\n`;
      ps += `for ($r = 0; $r -lt 15; $r++) { Start-Sleep -Milliseconds 40; $p.Refresh(); if ($p.MainWindowHandle -ne 0) { break } }\n`;
      ps += `try { [U.W]::MoveWindow($p.MainWindowHandle, ${x}, ${y}, ${tw}, ${th}, $true) } catch {}\n`;
    }

    fs.writeFileSync(spawnPs, ps, "utf8");
    exec(`powershell -ExecutionPolicy Bypass -File "${spawnPs}"`, { shell: true });
    // Wait for terminals to start spawning
    await new Promise((r) => setTimeout(r, count * 150));
    return { ok: true };
  }

  if (type === "close-apps") {
    exec("taskkill /IM cmd.exe /F", { shell: true });
    return { ok: true };
  }

  if (type === "watch-task-manager") {
    // Periodically kill Task Manager while takeover is active
    if (takeoverTaskManagerWatcher) clearInterval(takeoverTaskManagerWatcher);
    takeoverTaskManagerWatcher = setInterval(() => {
      if (!takeoverActive) {
        clearInterval(takeoverTaskManagerWatcher);
        takeoverTaskManagerWatcher = null;
        return;
      }
      exec("taskkill /IM Taskmgr.exe /F", { shell: true });
    }, 800);
    return { ok: true };
  }

  if (type === "save-wallpaper") {
    // Read and save current wallpaper path before changing it
    return new Promise((resolve) => {
      exec(
        `powershell -Command "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallPaper -EA SilentlyContinue).WallPaper"`,
        { shell: true },
        (err, stdout) => {
          takeoverSavedWallpaper = (stdout || "").trim() || null;
          resolve({ ok: true, saved: takeoverSavedWallpaper });
        }
      );
    });
  }

  if (type === "change-wallpaper") {
    // Create a tiny solid-black BMP and set it as wallpaper so the change is visible.
    // BMP format: 14-byte file header + 40-byte DIB header + 4 bytes pixel data (2x1 black)
    const blackBmp = path.join(app.getPath("userData"), "takeover-black.bmp");
    const header = Buffer.alloc(58, 0);
    // BM signature
    header.write("BM", 0);
    header.writeUInt32LE(58, 2);    // file size
    header.writeUInt32LE(54, 10);   // pixel data offset
    header.writeUInt32LE(40, 14);   // DIB header size
    header.writeInt32LE(1, 18);     // width
    header.writeInt32LE(1, 22);     // height
    header.writeUInt16LE(1, 26);    // color planes
    header.writeUInt16LE(24, 28);   // bits per pixel
    // pixel data: 1 black pixel (BGR) + 1 byte row padding
    header.writeUInt8(0, 54);
    header.writeUInt8(0, 55);
    header.writeUInt8(0, 56);
    header.writeUInt8(0, 57);
    fs.writeFileSync(blackBmp, header);

    const escaped = blackBmp.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const ps = `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WP { [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int a,int b,string c,int d); }';
[WP]::SystemParametersInfo(0x0014, 0, '${escaped}', 3)
    `.trim();
    return new Promise((resolve) => {
      exec(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { shell: true }, () => {
        resolve({ ok: true });
      });
    });
  }

  if (type === "restore-wallpaper") {
    const wpPath = takeoverSavedWallpaper || "";
    if (!wpPath) return { ok: true };
    const escaped = wpPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const ps = `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WP { [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int a,int b,string c,int d); }';
[WP]::SystemParametersInfo(0x0014, 0, '${escaped}', 3)
    `.trim();
    return new Promise((resolve) => {
      exec(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { shell: true }, () => {
        takeoverSavedWallpaper = null;
        resolve({ ok: true });
      });
    });
  }

  if (type === "move-window-random") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const display = screen.getPrimaryDisplay();
      const { width: sw, height: sh } = display.workAreaSize;
      // Randomize size between 200-500 for a frantic, glitchy feel
      const w = 200 + Math.floor(Math.random() * 300);
      const h = 250 + Math.floor(Math.random() * 300);
      mainWindow.setSize(w, h);
      const x = Math.floor(Math.random() * Math.max(1, sw - w));
      const y = Math.floor(Math.random() * Math.max(1, sh - h));
      mainWindow.setPosition(x, y);
    }
    return { ok: true };
  }

  return { ok: false, error: "Unknown takeover action" };
});

ipcMain.on("overlay:avatar-window-size", (_event, payload) => {
  if (!mainWindow || chatExpanded) return;
  const body = payload && typeof payload === "object" ? payload : {};
  const width = Math.max(AVATAR_ONLY_SIZE.width, Math.round(Number(body.width) || AVATAR_ONLY_SIZE.width));
  const height = Math.max(AVATAR_ONLY_SIZE.height, Math.round(Number(body.height) || AVATAR_ONLY_SIZE.height));
  mainWindow.setMinimumSize(200, 200);
  mainWindow.setSize(width, height, true);
});

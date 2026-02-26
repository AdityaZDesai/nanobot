const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, desktopCapturer, screen, systemPreferences, session } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ELEVENLABS_DEFAULT_VOICE_ID = "lhTvHflPVOqgSWyuWQry";

async function synthesizeSpeechWithElevenLabs(text) {
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY for ElevenLabs TTS");
  }

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
        model_id: "eleven_multilingual_v3",
        voice_settings: {
          stability: 0.32,
          similarity_boost: 0.85,
          style: 0.55,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${message || response.statusText}`);
  }

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
      randomChance: this.randomChance,
      quietHours: `${this.quietStartHour}:00-${this.quietEndHour}:00`,
      lastProactiveAt: this.lastProactiveAt,
    };
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
        command: "py",
        extraArgs: ["-3"],
        source: "py -3 fallback",
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
      mainWindow.webContents.send("backend:log", text);
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
        mainWindow.webContents.send("backend:exit", code);
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
            mainWindow.webContents.send("backend:ready");
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
          mainWindow.webContents.send("backend:log", String(err));
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 360,
    minHeight: 520,
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
  return responsePayload.text || "";
});

ipcMain.handle("overlay:get-proactive-status", () => {
  return proactiveCompanion.getStatus();
});

ipcMain.on("overlay:set-proactive", (_event, enabled) => {
  proactiveCompanion.setEnabled(enabled);
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

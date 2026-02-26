const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, desktopCapturer, screen } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let mainWindow = null;
let tray = null;

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

  start() {
    if (this.child) {
      return;
    }

    const python = process.env.NANOBOT_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const args = ["-m", "nanobot.desktop_bridge"];

    const backendCwd = process.env.NANOBOT_BACKEND_CWD || path.resolve(__dirname, "..");

    this.child = spawn(python, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: backendCwd,
    });

    this.child.stdout.on("data", (chunk) => this._onStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend:log", text);
      }
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
  createWindow();
  createTray();
  backend.start();
  screenCapture.start();

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
  return responsePayload.text || "";
});

ipcMain.handle("overlay:get-capture-status", () => {
  return screenCapture.getStatus();
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

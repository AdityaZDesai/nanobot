const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

let mainWindow = null;
let tray = null;

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
  backend.stop();
});

ipcMain.handle("overlay:send", async (_event, text) => {
  const payload = await backend.request("message", {
    text,
    session: "overlay:default",
  });
  return payload.text || "";
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

# Nanobot Overlay Desktop App

Always-on-top desktop overlay with a Live2D character and chat.

## Screen vision (periodic capture)

The overlay now captures a background screenshot every 5 seconds and attaches
the latest frame to each chat message so nanobot can "see" your screen.

- Toggle it in the overlay with `Vision`
- Change interval (2-60 seconds) with `Every Ns`
- On macOS, grant **Screen Recording** permission to Electron/Nanobot Overlay

## Requirements

- Node.js 20+
- Python 3.11+
- nanobot installed and configured (`nanobot onboard`)

## Run (dev)

```bash
cd desktop
npm install
npm run dev
```

Use `NANOBOT_PYTHON` to choose Python executable if needed:

```bash
NANOBOT_PYTHON=/usr/bin/python3 npm run dev
```

If your backend code is not in the parent directory of `desktop/`, set `NANOBOT_BACKEND_CWD`.

## Build installers

```bash
cd desktop
npm install
npm run build
```

Installer outputs are placed under `desktop/release/`.

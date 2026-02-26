# Nanobot Overlay Desktop App

Always-on-top desktop overlay with a Live2D character and chat.

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

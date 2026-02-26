# Nanobot Overlay Desktop App

Always-on-top desktop overlay with a Live2D character and chat.

## Screen vision (periodic capture)

The overlay now captures a background screenshot every 5 seconds and attaches
the latest frame to each chat message so nanobot can "see" your screen.

- Toggle it in the overlay with `Vision`
- Change interval (2-60 seconds) with `Every Ns`
- On macOS, grant **Screen Recording** permission to Electron/Nanobot Overlay

## Proactive desktop nudges

Desktop overlay includes a gentle proactive mode that checks in first when you have been idle.

- Desktop-only (no proactive DMs to Telegram/Discord)
- Uses latest screenshot context when available
- Guardrails: quiet hours, random chance, cooldown, and daily cap to avoid spam
- Toggle in overlay with `Proactive`
- Tune behavior in-overlay: idle minutes, cooldown, max/day, chance %, and quiet hours

## Voice output (ElevenLabs)

The overlay uses ElevenLabs TTS only (no browser speech fallback).

- Set `ELEVENLABS_API_KEY` before starting the app
- Default voice ID is `lhTvHflPVOqgSWyuWQry`
- Uses `eleven_v3` by default (`ELEVENLABS_MODEL_ID` to override)
- Automatically falls back to `eleven_multilingual_v2` if your account cannot access v3

Example:

```bash
cd desktop
ELEVENLABS_API_KEY=your_key_here npm run dev
```

## Voice input (Groq Whisper)

Desktop voice input now records microphone audio directly and transcribes it with Groq Whisper.

- Set `GROQ_API_KEY` before starting the app
- Click `Mic` to start recording, then click `Stop` to transcribe and send
- On macOS, grant **Microphone** permission for Nanobot Overlay

Example:

```bash
cd desktop
GROQ_API_KEY=your_key_here ELEVENLABS_API_KEY=your_key_here npm run dev
```

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

Python executable resolution order used by the desktop app:

1. `NANOBOT_PYTHON` (if set)
2. `venv/bin/python` (or `venv\\Scripts\\python.exe` on Windows) in backend cwd
3. `.venv/bin/python` (or `.venv\\Scripts\\python.exe` on Windows) in backend cwd
4. System fallback (`python3` on macOS/Linux, `py -3` on Windows)

If messages do not send and you see backend startup errors, set the interpreter explicitly:

```bash
cd desktop
NANOBOT_PYTHON=../venv/bin/python npm run dev
```

## Build installers

```bash
cd desktop
npm install
npm run build
```

Installer outputs are placed under `desktop/release/`.

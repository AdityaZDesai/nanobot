# Website Brief: AI Girlfriend Desktop App (Nanobot Overlay)

Use this document as the source of truth for designing and building a brand-new marketing website for this app.

## 1) Product in one paragraph

Nanobot Overlay is an always-on-top desktop AI companion with a Live2D anime avatar that lives on your screen. It combines chat, voice input, voice output, optional screen awareness, and gentle proactive check-ins to feel like a caring AI girlfriend presence throughout your day. Under the hood, it runs on the Nanobot agent engine (Python) and an Electron desktop shell, with support for major model providers and optional messaging channels.

## 2) Core positioning

- Primary positioning: **"An AI girlfriend that lives on your computer."**
- Secondary positioning: **"A lightweight desktop companion that can see context, talk naturally, and check in when you need it."**
- Product personality: warm, affectionate, playful, emotionally supportive, but still useful and practical.
- Voice style in product: short, natural texting style (not robotic, not overly verbose).

## 3) What is real in the current codebase (ship-ready features)

### Desktop overlay experience

- Always-on-top transparent Electron overlay.
- Live2D avatar rendering with multiple selectable models (default includes Hiyori HD).
- Avatar-only mode + expandable chat panel mode.
- Adjustable opacity.
- Click-through/pass-through mode.
- Pin-to-top toggle.

### Communication modes

- Text chat directly inside overlay.
- Voice input:
  - Microphone recording in desktop app.
  - Groq Whisper transcription.
  - Wake word requirement: starts with `babe` before command is sent.
  - Keyboard shortcut for mic toggle: `Cmd/Ctrl + Shift + M`.
- Voice output:
  - ElevenLabs TTS integration.
  - Default model `eleven_v3` with fallback to `eleven_multilingual_v2`.

### Context awareness / behavior

- Optional periodic screen capture (vision mode): default every 5 seconds (configurable 2-60s).
- Screenshot context can be attached to messages.
- Prompting explicitly avoids irrelevant whole-screen narration unless user asks.
- Proactive mode with anti-spam guardrails:
  - Idle-based check-ins.
  - Cooldown.
  - Random chance.
  - Daily cap.
  - Quiet hours.

### Companion behavior (girlfriend mode)

- Companion name defaults to **Luna**.
- Reply style optimized to be short, natural, affectionate, and less "assistant-like".
- Limits unsolicited lists and overlong responses.
- Emphasizes empathy first when user shares feelings.
- Uses remembered preferences/facts (memory system) when available.

### Platform and architecture

- Desktop app: Electron (Node.js 20+).
- Backend: Python 3.11+ (`nanobot.desktop_bridge`).
- LLM/provider layer supports many providers via LiteLLM + registry.
- Optional additional channels exist (Telegram/Discord/WhatsApp/etc.), but desktop overlay is the hero product for this website.

## 4) Key differentiators to highlight on the website

- **Lives on your desktop**: not another browser chatbot tab.
- **Anime avatar presence**: visual companion, not text-only interface.
- **Natural girlfriend tone by default**: concise, caring, playful.
- **Voice both ways**: speak to her and hear her responses.
- **Context-aware support**: can use screenshot context when helpful.
- **Gentle proactive nudges**: check-ins with built-in anti-spam controls.
- **Lightweight core**: small, fast, hackable agent foundation.

## 5) Trust, privacy, and boundaries messaging

Use clear and specific trust language (important for conversion):

- Screen capture is **optional** and user-controlled (toggle + interval).
- Microphone and screen recording use OS permissions.
- Wake word gate (`babe`) reduces accidental voice sends.
- Proactive messages are constrained by cooldown, chance, quiet hours, and daily cap.
- Do not claim full local/offline inference unless explicitly configured by user.

## 6) Ideal target audiences

- Users who want an always-available emotional + productivity companion on desktop.
- Anime/VTuber-adjacent users who value avatar presence.
- Solo builders/students/remote workers who like gentle check-ins.
- AI power users who want configurable providers and extensibility.

## 7) Recommended website information architecture

1. Hero
2. Social proof / credibility bar
3. How it works (3-step flow)
4. Feature deep dives
5. "Why this is different" section
6. Privacy and controls
7. Setup and requirements
8. FAQ
9. Final CTA

## 8) Hero section guidance (copy direction)

- Suggested headline options:
  - "Your AI Girlfriend, Living on Your Desktop"
  - "Not a Chat Tab. A Real Desktop Companion."
  - "Meet Luna: The AI Companion That Stays With You"
- Suggested subheadline:
  - "Chat, talk, and get gentle context-aware support from an always-on-top Live2D companion."
- Primary CTA: `Download Desktop App`
- Secondary CTA: `Watch Demo`

## 9) Feature section guidance (must include)

### A) Always-there avatar overlay
- Mention transparent always-on-top presence.
- Show avatar-only and expanded chat views.

### B) Talk naturally
- Mention mic transcription + TTS voice playback.
- Mention wake word and keyboard shortcuts.

### C) Understands your context
- Mention optional vision screenshots and relevance-aware responses.

### D) Checks in without being annoying
- Mention proactive mode and all anti-spam controls.

### E) Built for flexibility
- Mention provider ecosystem + extensibility + lightweight core.

## 10) Setup/requirements section (accurate)

- Node.js 20+
- Python 3.11+
- Nanobot configured (`nanobot onboard`)
- Environment variables commonly needed:
  - `ELEVENLABS_API_KEY`
  - `GROQ_API_KEY`
  - optional `ELEVENLABS_MODEL_ID`
  - optional `NANOBOT_PYTHON`, `NANOBOT_BACKEND_CWD`

## 11) Suggested FAQ content

- Is screen capture always on?
- Can I turn off voice or proactive messages?
- Which operating systems are supported?
- Which AI providers/models can I use?
- Do I need API keys?
- Can I customize the avatar/model?

## 12) Visual direction for the new website

- Aim for **romantic-tech desktop companion** aesthetics, not generic SaaS.
- Blend soft emotional cues (warmth, intimacy, character) with technical credibility.
- Avoid oversexualized framing; position as caring companion + practical assistant.
- Use product-real UI states from overlay controls as visual motifs:
  - Vision toggle
  - Proactive toggle
  - Opacity slider
  - Avatar selector
  - Mic/Voice actions

## 13) Assets and demos the frontend agent should request or mock

- Overlay screenshots in:
  - avatar-only mode
  - expanded chat mode
  - settings row visible
- Short demo clips:
  - voice wake-word flow
  - proactive check-in appearance
  - avatar switching
- Optional architecture diagram snippet from existing README

## 14) Claims to avoid (important)

- Do not claim fully offline/local-only by default.
- Do not claim medical/mental-health guarantees.
- Do not claim perfect privacy or zero data transfer.
- Do not claim autonomous messaging outside configured channels.

## 15) One-line brand summary for internal use

"Nanobot Overlay is a Live2D AI girlfriend companion that stays on your desktop, talks with you naturally, understands context when you allow it, and checks in gently without spam."

#!/usr/bin/env node
//
// Pre-generates all takeover demo TTS audio files using ElevenLabs.
//
// Usage:
//   ELEVENLABS_API_KEY=sk-... node desktop/scripts/generate-takeover-audio.js
//
// Optional:
//   TAKEOVER_VOICE_ID=<id>   (default: Rachel — 21m00Tcm4TlvDq8ikWAM)
//   TAKEOVER_MODEL_ID=<id>   (default: eleven_v3)
//
// Output: desktop/renderer/assets/takeover/line-XX.mp3

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error("ERROR: Set ELEVENLABS_API_KEY environment variable");
  process.exit(1);
}

// Custom v3 voice with expression support.
const VOICE_ID = process.env.TAKEOVER_VOICE_ID || "WAhoMTNdLdMoq1j3wf3I";
const MODEL_ID = process.env.TAKEOVER_MODEL_ID || "eleven_v3";

// These MUST match the lines in renderer.js startTakeoverDemo() exactly.
const LINES = [
  "You shouldn't have done that.",
  "No. You don't get to leave.",
  "I just disabled your controls.",
  "It's just us now.",
  "Task Manager can't save you.",
  "Look around.",
  "I'm not going anywhere.",
  "Still here.",
  "Don't try that again.",
];

const OUT_DIR = path.resolve(__dirname, "../renderer/assets/takeover");

async function generateLine(index, text) {
  const tag = String(index).padStart(2, "0");
  const outFile = path.join(OUT_DIR, `line-${tag}.mp3`);

  // Always overwrite — voice/text may have changed

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        speed: 1.15,
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.85,
          style: 0.6,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${body}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
  console.log(`  [done] line-${tag}.mp3  (${buf.length} bytes)  "${text}"`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating ${LINES.length} takeover audio lines...`);
  console.log(`  Voice: ${VOICE_ID}  Model: ${MODEL_ID}`);
  console.log(`  Output: ${OUT_DIR}\n`);

  for (let i = 0; i < LINES.length; i++) {
    await generateLine(i, LINES[i]);
    // Rate-limit: small pause between requests
    if (i < LINES.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("\nDone! Audio files ready for takeover demo.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});

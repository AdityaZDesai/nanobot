"""JSON-over-stdio bridge for the desktop overlay app."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class BridgeRequest:
    request_id: str
    req_type: str
    payload: dict[str, Any]


class DesktopBridge:
    def __init__(self) -> None:
        self.agent_loop = None

    async def start(self) -> None:
        from nanobot.agent.loop import AgentLoop
        from nanobot.bus.queue import MessageBus
        from nanobot.config.loader import get_data_dir, load_config
        from nanobot.cron.service import CronService
        from nanobot.providers.registry import find_by_name
        from nanobot.providers.custom_provider import CustomProvider
        from nanobot.providers.litellm_provider import LiteLLMProvider
        from nanobot.providers.openai_codex_provider import OpenAICodexProvider

        config = load_config()
        bus = MessageBus()
        model = config.agents.defaults.model
        provider_name = config.get_provider_name(model)
        provider_cfg = config.get_provider(model)

        if provider_name == "openai_codex" or model.startswith("openai-codex/"):
            provider = OpenAICodexProvider(default_model=model)
        elif provider_name == "custom":
            provider = CustomProvider(
                api_key=provider_cfg.api_key if provider_cfg else "no-key",
                api_base=config.get_api_base(model) or "http://localhost:8000/v1",
                default_model=model,
            )
        else:
            spec = find_by_name(provider_name)
            if (
                not model.startswith("bedrock/")
                and not (provider_cfg and provider_cfg.api_key)
                and not (spec and spec.is_oauth)
            ):
                raise RuntimeError(
                    "No API key configured. Set one in ~/.nanobot/config.json under providers section."
                )
            provider = LiteLLMProvider(
                api_key=provider_cfg.api_key if provider_cfg else None,
                api_base=config.get_api_base(model),
                default_model=model,
                extra_headers=provider_cfg.extra_headers if provider_cfg else None,
                provider_name=provider_name,
            )

        cron_store_path = get_data_dir() / "cron" / "jobs.json"
        cron = CronService(cron_store_path)

        self.agent_loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=config.workspace_path,
            model=config.agents.defaults.model,
            temperature=config.agents.defaults.temperature,
            max_tokens=config.agents.defaults.max_tokens,
            max_iterations=config.agents.defaults.max_tool_iterations,
            memory_window=config.agents.defaults.memory_window,
            brave_api_key=config.tools.web.search.api_key or None,
            exec_config=config.tools.exec,
            cron_service=cron,
            restrict_to_workspace=config.tools.restrict_to_workspace,
            mcp_servers=config.tools.mcp_servers,
            channels_config=config.channels,
        )

    async def stop(self) -> None:
        if self.agent_loop:
            await self.agent_loop.close_mcp()
            self.agent_loop = None

    async def handle(self, request: BridgeRequest) -> dict[str, Any]:
        if request.req_type == "health":
            return {"ok": True}

        if request.req_type == "message":
            if not self.agent_loop:
                raise RuntimeError("Bridge backend is not initialized")

            text = str(request.payload.get("text", "")).strip()
            if not text:
                return {"text": ""}

            session = str(request.payload.get("session", "overlay:default"))
            raw_media = request.payload.get("media") or []
            media = (
                [str(item) for item in raw_media if isinstance(item, str)]
                if isinstance(raw_media, list)
                else []
            )
            response = await self.agent_loop.process_direct(text, session, media=media)
            return {"text": response or ""}

        if request.req_type == "proactive":
            if not self.agent_loop:
                raise RuntimeError("Bridge backend is not initialized")

            session = str(request.payload.get("session", "overlay:default"))
            idle_minutes = int(request.payload.get("idle_minutes") or 0)
            local_time = str(request.payload.get("local_time") or "")
            raw_media = request.payload.get("media") or []
            media = (
                [str(item) for item in raw_media if isinstance(item, str)]
                if isinstance(raw_media, list)
                else []
            )

            proactive_prompt = (
                "You are proactively checking in with the user in desktop overlay mode. "
                "Create exactly one short, natural, non-annoying message (max 2 sentences) that is warm and productive. "
                "If screenshots are attached, ground your message in visible context and suggest one small next step. "
                "Do not sound robotic, do not guilt-trip, and do not send generic spammy motivation. "
                "Do not mention screenshots unless it helps the suggestion feel natural. "
                "If there is no meaningful, useful nudge right now, reply exactly with __SKIP__. "
                f"The user has been idle for about {idle_minutes} minutes. "
                f"Local time: {local_time or 'unknown'}."
            )

            response = await self.agent_loop.process_direct(proactive_prompt, session, media=media)
            text = (response or "").strip()
            if text == "__SKIP__":
                return {"text": ""}
            return {"text": text}

        if request.req_type == "transcribe":
            audio_base64 = str(request.payload.get("audio_base64", "")).strip()
            mime_type = str(request.payload.get("mime_type", "audio/webm")).strip().lower()
            if not audio_base64:
                return {"text": "", "error": "No audio payload provided"}

            ext_map = {
                "audio/webm": ".webm",
                "audio/ogg": ".ogg",
                "audio/mp4": ".m4a",
                "audio/mpeg": ".mp3",
                "audio/wav": ".wav",
                "audio/x-wav": ".wav",
            }
            suffix = ext_map.get(mime_type, ".webm")

            try:
                audio_bytes = base64.b64decode(audio_base64, validate=True)
            except Exception:
                return {"text": "", "error": "Invalid audio encoding"}

            if not audio_bytes:
                return {"text": "", "error": "Empty audio payload"}

            from nanobot.providers.transcription import GroqTranscriptionProvider

            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = Path(tmp.name)

            try:
                transcriber = GroqTranscriptionProvider()
                text = (await transcriber.transcribe(tmp_path)).strip()
                if not text:
                    return {
                        "text": "",
                        "error": "Transcription unavailable. Set GROQ_API_KEY and try again.",
                    }
                return {"text": text}
            finally:
                try:
                    tmp_path.unlink(missing_ok=True)
                except Exception:
                    pass

        raise ValueError(f"Unsupported request type: {request.req_type}")


def _parse_request(line: str) -> BridgeRequest:
    data = json.loads(line)
    request_id = str(data.get("id", ""))
    req_type = str(data.get("type", ""))
    payload = data.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    if not request_id or not req_type:
        raise ValueError("Request must include 'id' and 'type'")
    return BridgeRequest(request_id=request_id, req_type=req_type, payload=payload)


def _emit(data: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(data, ensure_ascii=True) + "\n")
    sys.stdout.flush()


async def _readline() -> str:
    return await asyncio.to_thread(sys.stdin.readline)


async def main() -> None:
    bridge = DesktopBridge()
    await bridge.start()
    _emit({"type": "ready"})

    try:
        while True:
            line = await _readline()
            if not line:
                break

            raw = line.strip()
            if not raw:
                continue

            try:
                request = _parse_request(raw)
                payload = await bridge.handle(request)
                _emit({"id": request.request_id, "ok": True, "payload": payload})
            except Exception as exc:
                request_id = ""
                try:
                    request_id = str(json.loads(raw).get("id", ""))
                except Exception:
                    pass
                _emit(
                    {
                        "id": request_id,
                        "ok": False,
                        "error": str(exc),
                    }
                )
    finally:
        await bridge.stop()


if __name__ == "__main__":
    asyncio.run(main())

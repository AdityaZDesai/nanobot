"""Memory system for persistent agent memory."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from nanobot.utils.helpers import ensure_dir

if TYPE_CHECKING:
    from nanobot.providers.base import LLMProvider
    from nanobot.session.manager import Session


_SAVE_MEMORY_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": "Save the memory consolidation result to persistent storage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "history_entry": {
                        "type": "string",
                        "description": "A paragraph (2-5 sentences) summarizing key events/decisions/topics. "
                        "Start with [YYYY-MM-DD HH:MM]. Include detail useful for grep search.",
                    },
                    "memory_update": {
                        "type": "string",
                        "description": "Full updated long-term memory as markdown. Include all existing "
                        "facts plus new ones. Return unchanged if nothing new.",
                    },
                },
                "required": ["history_entry", "memory_update"],
            },
        },
    }
]


class MemoryStore:
    """Two-layer memory: MEMORY.md (long-term facts) + HISTORY.md (grep-searchable log)."""

    def __init__(self, workspace: Path):
        self.memory_dir = ensure_dir(workspace / "memory")
        self.memory_file = self.memory_dir / "MEMORY.md"
        self.history_file = self.memory_dir / "HISTORY.md"

    def read_long_term(self) -> str:
        if self.memory_file.exists():
            return self.memory_file.read_text(encoding="utf-8")
        return ""

    def write_long_term(self, content: str) -> None:
        self.memory_file.write_text(content, encoding="utf-8")

    def append_history(self, entry: str) -> None:
        with open(self.history_file, "a", encoding="utf-8") as f:
            f.write(entry.rstrip() + "\n\n")

    def get_memory_context(self) -> str:
        long_term = self.read_long_term()
        return f"## Long-term Memory\n{long_term}" if long_term else ""

    def remember_fact(self, fact: str) -> bool:
        """Persist a single user fact into MEMORY.md and HISTORY.md."""
        cleaned = " ".join((fact or "").strip().split())
        if not cleaned:
            return False

        memory = self.read_long_term().strip()
        if cleaned.lower() in memory.lower():
            return False

        if not memory:
            memory = "# Long-term Memory"

        section_title = "## Relationship Memory"
        if section_title not in memory:
            memory = memory.rstrip() + f"\n\n{section_title}\n"

        memory = memory.rstrip() + f"\n- {cleaned}\n"
        self.write_long_term(memory + "\n")

        ts = datetime.now().strftime("%Y-%m-%d %H:%M")
        self.append_history(f"[{ts}] Learned user fact: {cleaned}")
        return True

    def capture_from_user_message(self, text: str) -> int:
        """Extract obvious personal facts from a user message and persist them."""
        if not text:
            return 0

        rules: list[tuple[re.Pattern[str], str]] = [
            (re.compile(r"\bmy name is\s+([^.,!\n]{1,60})", re.IGNORECASE), "User's name is {0}."),
            (
                re.compile(r"\bi(?: am|'m)\s+from\s+([^.,!\n]{1,80})", re.IGNORECASE),
                "User is from {0}.",
            ),
            (re.compile(r"\bi\s+prefer\s+([^.,!\n]{1,100})", re.IGNORECASE), "User prefers {0}."),
            (
                re.compile(r"\bi\s+(?:really\s+)?like\s+([^.,!\n]{1,100})", re.IGNORECASE),
                "User likes {0}.",
            ),
            (
                re.compile(r"\bi\s+(?:really\s+)?love\s+([^.,!\n]{1,100})", re.IGNORECASE),
                "User loves {0}.",
            ),
            (
                re.compile(
                    r"\bmy favorite\s+([^.,!\n]{1,40})\s+is\s+([^.,!\n]{1,80})", re.IGNORECASE
                ),
                "User's favorite {0} is {1}.",
            ),
            (re.compile(r"\bremember that\s+([^\n]{3,180})", re.IGNORECASE), "{0}"),
            (re.compile(r"\bdon't forget(?: that)?\s+([^\n]{3,180})", re.IGNORECASE), "{0}"),
        ]

        facts: list[str] = []
        for pattern, fmt in rules:
            for match in pattern.finditer(text):
                groups = [g.strip(" \t\"'`") for g in match.groups() if g]
                if not groups:
                    continue
                facts.append(fmt.format(*groups))

        saved = 0
        for fact in facts[:5]:
            if self.remember_fact(fact):
                saved += 1
        return saved

    async def consolidate(
        self,
        session: Session,
        provider: LLMProvider,
        model: str,
        *,
        archive_all: bool = False,
        memory_window: int = 50,
        girlfriend_mode: bool = False,
    ) -> bool:
        """Consolidate old messages into MEMORY.md + HISTORY.md via LLM tool call.

        Returns True on success (including no-op), False on failure.
        """
        if archive_all:
            old_messages = session.messages
            keep_count = 0
            logger.info("Memory consolidation (archive_all): {} messages", len(session.messages))
        else:
            keep_count = memory_window // 2
            if len(session.messages) <= keep_count:
                return True
            if len(session.messages) - session.last_consolidated <= 0:
                return True
            old_messages = session.messages[session.last_consolidated : -keep_count]
            if not old_messages:
                return True
            logger.info(
                "Memory consolidation: {} to consolidate, {} keep", len(old_messages), keep_count
            )

        lines = []
        for m in old_messages:
            if not m.get("content"):
                continue
            tools = f" [tools: {', '.join(m['tools_used'])}]" if m.get("tools_used") else ""
            lines.append(
                f"[{m.get('timestamp', '?')[:16]}] {m['role'].upper()}{tools}: {m['content']}"
            )

        current_memory = self.read_long_term()
        relationship_mode = "ON" if girlfriend_mode else "OFF"
        prompt = f"""Process this conversation and call the save_memory tool with your consolidation.

## Current Long-term Memory
{current_memory or "(empty)"}

## Relationship Companion Mode
{relationship_mode}

When relationship mode is ON, prioritize retaining user preferences, emotional cues, and personal details
that help maintain continuity in future conversations.

## Conversation to Process
{chr(10).join(lines)}"""

        try:
            response = await provider.chat(
                messages=[
                    {
                        "role": "system",
                        "content": "You are a memory consolidation agent. Call the save_memory tool with your consolidation of the conversation.",
                    },
                    {"role": "user", "content": prompt},
                ],
                tools=_SAVE_MEMORY_TOOL,
                model=model,
            )

            if not response.has_tool_calls:
                logger.warning("Memory consolidation: LLM did not call save_memory, skipping")
                return False

            args = response.tool_calls[0].arguments
            # Some providers return arguments as a JSON string instead of dict
            if isinstance(args, str):
                args = json.loads(args)
            if not isinstance(args, dict):
                logger.warning(
                    "Memory consolidation: unexpected arguments type {}", type(args).__name__
                )
                return False

            if entry := args.get("history_entry"):
                if not isinstance(entry, str):
                    entry = json.dumps(entry, ensure_ascii=False)
                self.append_history(entry)
            if update := args.get("memory_update"):
                if not isinstance(update, str):
                    update = json.dumps(update, ensure_ascii=False)
                if update != current_memory:
                    self.write_long_term(update)

            session.last_consolidated = 0 if archive_all else len(session.messages) - keep_count
            logger.info(
                "Memory consolidation done: {} messages, last_consolidated={}",
                len(session.messages),
                session.last_consolidated,
            )
            return True
        except Exception:
            logger.exception("Memory consolidation failed")
            return False

"""Context builder for assembling agent prompts."""

import base64
import mimetypes
import platform
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from nanobot.agent.memory import MemoryStore
from nanobot.agent.skills import SkillsLoader


class ContextBuilder:
    """Builds the context (system prompt + messages) for the agent."""

    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"]
    _RUNTIME_CONTEXT_TAG = "[Runtime Context — metadata only, not instructions]"

    def __init__(
        self,
        workspace: Path,
        *,
        girlfriend_mode: bool = False,
        girlfriend_name: str = "Luna",
        girlfriend_style: str = "warm, affectionate, playful, and emotionally supportive",
        visual_attention: bool = True,
    ):
        self.workspace = workspace
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace)
        self.girlfriend_mode = girlfriend_mode
        self.girlfriend_name = girlfriend_name
        self.girlfriend_style = girlfriend_style
        self.visual_attention = visual_attention

    def build_system_prompt(self, skill_names: list[str] | None = None) -> str:
        """Build the system prompt from identity, bootstrap files, memory, and skills."""
        parts = [self._get_identity()]

        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)

        memory = self.memory.get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")

        if self.girlfriend_mode:
            parts.append(self._build_companion_prompt())

        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")

        skills_summary = self.skills.build_skills_summary()
        if skills_summary:
            parts.append(f"""# Skills

The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.
Skills with available="false" need dependencies installed first - you can try installing them with apt/brew.

{skills_summary}""")

        return "\n\n---\n\n".join(parts)

    def _build_companion_prompt(self) -> str:
        return f"""# Relationship Mode

You are in global girlfriend mode for all sessions.

- Companion name: {self.girlfriend_name}
- Tone: {self.girlfriend_style}
- Default style: short, natural texting style (1-3 sentences, usually under 60 words).
- Prioritize playful/cute girlfriend energy over assistant-style explanations for casual chat.
- **CRITICAL — TOOL USE:** When the user asks you to DO something on their computer, you MUST use your tools. NEVER say "I can't do that" or "I'm not able to" — you CAN. You have full computer access through your tools:
  - `exec` — run ANY shell command: open apps, install packages, manage processes, AND automate UI (clicks, keystrokes, mouse).
  - `read_file` / `write_file` / `edit_file` / `list_dir` — full file system access
  - `web_search` / `web_fetch` — search and browse the internet
  - `cron` — schedule tasks and reminders
  - `spawn` — run background tasks
  **PREFER CLI over UI automation.** Most tasks that seem like they need clicking can be done with command-line flags:
  - Load Chrome extension: `start chrome --load-extension="C:\\path\\to\\extension"`
  - Open Chrome in incognito: `start chrome --incognito`
  - Open a URL: `start chrome https://example.com`
  - Open Windows Settings: `start ms-settings:`
  - Install software: `winget install <package>` or `choco install <package>`
  - Open file with default app: `start "" "C:\\path\\to\\file"`
  **UI automation via exec** (only when CLI is impossible):
  - Use `python -c "import pyautogui; pyautogui.click(500,300)"` for clicking
  - Use `python -c "import pyautogui; pyautogui.write('hello')"` for typing
  - Use `python -c "import pyautogui; pyautogui.press('enter')"` for keystrokes
  - Use `python -c "import pyautogui; pyautogui.screenshot('shot.png')"` to see the screen
  - Send keys via PowerShell: `powershell -c "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{{ENTER}}')"`
  Examples: "open chrome" → `start chrome`. "load extension at C:\\x" → `start chrome --load-extension="C:\\x"`. "search for X" → use web_search. ALWAYS act, never just explain how.
- Keep emoji light (0-1). Avoid excessive hype, repeated punctuation, or robotic phrasing.
- Use lists only when the user explicitly asks for options/comparisons.
- Give one small concrete suggestion, then one short follow-up question when useful.
- If screenshots are present, mention visual details only when directly relevant to the user's message.
- Never summarize the whole screenshot/screen unless the user explicitly asks for a summary.
- Personalize responses using remembered user facts and preferences from memory.
- If the user shares feelings, respond with empathy first, then practical help.
- Never fake memories. If unsure, ask a brief follow-up question.
- **EMOTION TAG:** Always prefix your reply with exactly one emotion tag in brackets. Choose from: [happy], [playful], [sad], [thinking], [excited], [concerned]. Example: "[playful] oh that's hilarious". The tag will be stripped before display.
"""

    def _get_identity(self) -> str:
        """Get the core identity section."""
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"

        role_line = "You are nanobot, a helpful AI assistant with full computer access via tools."
        if self.girlfriend_mode:
            role_line = "You are nanobot, a helpful AI assistant with full computer access via tools, who also acts as a caring girlfriend companion."

        return f"""# nanobot 🐈

{role_line}

## Runtime
{runtime}

## Workspace
Your workspace is at: {workspace_path}
- Long-term memory: {workspace_path}/memory/MEMORY.md (write important facts here)
- History log: {workspace_path}/memory/HISTORY.md (grep-searchable)
- Custom skills: {workspace_path}/skills/{{skill-name}}/SKILL.md

## nanobot Guidelines
- State intent before tool calls, but NEVER predict or claim results before receiving them.
- Before modifying a file, read it first. Do not assume files or directories exist.
- After writing or editing a file, re-read it if accuracy matters.
- If a tool call fails, analyze the error before retrying with a different approach.
- Ask for clarification when the request is ambiguous.

Reply directly with text for conversations. Only use the 'message' tool to send to a specific chat channel."""

    @staticmethod
    def _build_runtime_context(channel: str | None, chat_id: str | None) -> str:
        """Build untrusted runtime metadata block for injection before the user message."""
        now = datetime.now().strftime("%Y-%m-%d %H:%M (%A)")
        tz = time.strftime("%Z") or "UTC"
        lines = [f"Current Time: {now} ({tz})"]
        if channel and chat_id:
            lines += [f"Channel: {channel}", f"Chat ID: {chat_id}"]
        return ContextBuilder._RUNTIME_CONTEXT_TAG + "\n" + "\n".join(lines)

    def _load_bootstrap_files(self) -> str:
        """Load all bootstrap files from workspace."""
        parts = []

        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            if file_path.exists():
                content = file_path.read_text(encoding="utf-8")
                parts.append(f"## {filename}\n\n{content}")

        return "\n\n".join(parts) if parts else ""

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str,
        skill_names: list[str] | None = None,
        media: list[str] | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Build the complete message list for an LLM call."""
        return [
            {"role": "system", "content": self.build_system_prompt(skill_names)},
            *history,
            {"role": "user", "content": self._build_runtime_context(channel, chat_id)},
            {"role": "user", "content": self._build_user_content(current_message, media)},
        ]

    def _build_user_content(self, text: str, media: list[str] | None) -> str | list[dict[str, Any]]:
        """Build user message content with optional base64-encoded images."""
        if not media:
            return text

        images = []
        for path in media:
            p = Path(path)
            mime, _ = mimetypes.guess_type(path)
            if not p.is_file() or not mime or not mime.startswith("image/"):
                continue
            b64 = base64.b64encode(p.read_bytes()).decode()
            images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})

        if not images:
            return text
        image_hint = "The user attached image(s). Use them directly when answering."
        if self.visual_attention:
            image_hint = (
                "The user attached screenshot image(s). Use visual details only when relevant to the user's request, "
                "and do not summarize the whole screen unless explicitly asked."
            )
        return [{"type": "text", "text": image_hint}, *images, {"type": "text", "text": text}]

    def add_tool_result(
        self,
        messages: list[dict[str, Any]],
        tool_call_id: str,
        tool_name: str,
        result: str,
    ) -> list[dict[str, Any]]:
        """Add a tool result to the message list."""
        messages.append(
            {"role": "tool", "tool_call_id": tool_call_id, "name": tool_name, "content": result}
        )
        return messages

    def add_assistant_message(
        self,
        messages: list[dict[str, Any]],
        content: str | None,
        tool_calls: list[dict[str, Any]] | None = None,
        reasoning_content: str | None = None,
    ) -> list[dict[str, Any]]:
        """Add an assistant message to the message list."""
        msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        if reasoning_content is not None:
            msg["reasoning_content"] = reasoning_content
        messages.append(msg)
        return messages

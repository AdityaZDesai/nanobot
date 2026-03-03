"""LiteLLM provider implementation for multi-provider support."""

import asyncio
import json
import json_repair
import os
import re
import uuid
from typing import Any

import litellm
from litellm import acompletion

from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.providers.registry import find_by_model, find_gateway


# Standard OpenAI chat-completion message keys plus reasoning_content for
# thinking-enabled models (Kimi k2.5, DeepSeek-R1, etc.).
_ALLOWED_MSG_KEYS = frozenset({"role", "content", "tool_calls", "tool_call_id", "name", "reasoning_content"})


class LiteLLMProvider(LLMProvider):
    """
    LLM provider using LiteLLM for multi-provider support.
    
    Supports OpenRouter, Anthropic, OpenAI, Gemini, MiniMax, and many other providers through
    a unified interface.  Provider-specific logic is driven by the registry
    (see providers/registry.py) — no if-elif chains needed here.
    """
    
    def __init__(
        self,
        api_key: str | None = None,
        api_base: str | None = None,
        default_model: str = "anthropic/claude-opus-4-5",
        extra_headers: dict[str, str] | None = None,
        provider_name: str | None = None,
        fallback_models: list[str] | None = None,
        model_tiers: dict[str, str] | None = None,
    ):
        super().__init__(api_key, api_base)
        self.default_model = default_model
        self.extra_headers = extra_headers or {}
        self.fallback_models = fallback_models or []
        self.model_tiers = model_tiers or {}  # {"easy": "...", "medium": "...", "hard": "...", "expert": "..."}
        
        # Detect gateway / local deployment.
        # provider_name (from config key) is the primary signal;
        # api_key / api_base are fallback for auto-detection.
        self._gateway = find_gateway(provider_name, api_key, api_base)
        
        # Configure environment variables
        if api_key:
            self._setup_env(api_key, api_base, default_model)
        
        if api_base:
            litellm.api_base = api_base
        
        # Disable LiteLLM logging noise
        litellm.suppress_debug_info = True
        # Drop unsupported parameters for providers (e.g., gpt-5 rejects some params)
        litellm.drop_params = True
    
    def _setup_env(self, api_key: str, api_base: str | None, model: str) -> None:
        """Set environment variables based on detected provider."""
        spec = self._gateway or find_by_model(model)
        if not spec:
            return
        if not spec.env_key:
            # OAuth/provider-only specs (for example: openai_codex)
            return

        # Gateway/local overrides existing env; standard provider doesn't
        if self._gateway:
            os.environ[spec.env_key] = api_key
        else:
            os.environ.setdefault(spec.env_key, api_key)

        # Resolve env_extras placeholders:
        #   {api_key}  → user's API key
        #   {api_base} → user's api_base, falling back to spec.default_api_base
        effective_base = api_base or spec.default_api_base
        for env_name, env_val in spec.env_extras:
            resolved = env_val.replace("{api_key}", api_key)
            resolved = resolved.replace("{api_base}", effective_base)
            os.environ.setdefault(env_name, resolved)
    
    def _resolve_model(self, model: str) -> str:
        """Resolve model name by applying provider/gateway prefixes."""
        if self._gateway:
            # Gateway mode: apply gateway prefix, skip provider-specific prefixes
            prefix = self._gateway.litellm_prefix
            if self._gateway.strip_model_prefix:
                model = model.split("/")[-1]
            if prefix and not model.startswith(f"{prefix}/"):
                model = f"{prefix}/{model}"
            return model
        
        # Standard mode: auto-prefix for known providers
        spec = find_by_model(model)
        if spec and spec.litellm_prefix:
            model = self._canonicalize_explicit_prefix(model, spec.name, spec.litellm_prefix)
            if not any(model.startswith(s) for s in spec.skip_prefixes):
                model = f"{spec.litellm_prefix}/{model}"

        return model

    @staticmethod
    def _canonicalize_explicit_prefix(model: str, spec_name: str, canonical_prefix: str) -> str:
        """Normalize explicit provider prefixes like `github-copilot/...`."""
        if "/" not in model:
            return model
        prefix, remainder = model.split("/", 1)
        if prefix.lower().replace("-", "_") != spec_name:
            return model
        return f"{canonical_prefix}/{remainder}"
    
    def _supports_cache_control(self, model: str) -> bool:
        """Return True when the provider supports cache_control on content blocks."""
        if self._gateway is not None:
            return self._gateway.supports_prompt_caching
        spec = find_by_model(model)
        return spec is not None and spec.supports_prompt_caching

    def _apply_cache_control(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]] | None]:
        """Return copies of messages and tools with cache_control injected."""
        new_messages = []
        for msg in messages:
            if msg.get("role") == "system":
                content = msg["content"]
                if isinstance(content, str):
                    new_content = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
                else:
                    new_content = list(content)
                    new_content[-1] = {**new_content[-1], "cache_control": {"type": "ephemeral"}}
                new_messages.append({**msg, "content": new_content})
            else:
                new_messages.append(msg)

        new_tools = tools
        if tools:
            new_tools = list(tools)
            new_tools[-1] = {**new_tools[-1], "cache_control": {"type": "ephemeral"}}

        return new_messages, new_tools

    def _apply_model_overrides(self, model: str, kwargs: dict[str, Any]) -> None:
        """Apply model-specific parameter overrides from the registry."""
        model_lower = model.lower()
        spec = find_by_model(model)
        if spec:
            for pattern, overrides in spec.model_overrides:
                if pattern in model_lower:
                    kwargs.update(overrides)
                    return
    
    def _sanitize_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Strip non-standard keys, ensure content is always a string for strict providers."""
        model = self.default_model
        supports_vision = self._model_supports_vision(model)
        sanitized = []
        for msg in messages:
            clean = {k: v for k, v in msg.items() if k in _ALLOWED_MSG_KEYS}
            # Strict providers require "content" even when assistant only has tool_calls
            if clean.get("role") == "assistant" and "content" not in clean:
                clean["content"] = ""
            # Ensure content is never None — some providers (Groq) reject it
            if clean.get("content") is None:
                clean["content"] = ""
            # Flatten list content to text for non-vision models
            if isinstance(clean.get("content"), list) and not supports_vision:
                text_parts = [
                    item.get("text", "")
                    for item in clean["content"]
                    if isinstance(item, dict) and item.get("type") in ("text", "input_text")
                ]
                clean["content"] = "\n".join(t for t in text_parts if t)
            sanitized.append(clean)
        return sanitized

    @staticmethod
    def _model_supports_vision(model: str) -> bool:
        """Check if the model likely supports vision/image inputs."""
        lower = model.lower()
        vision_keywords = ("vision", "gpt-4o", "gpt-4-turbo", "claude", "gemini", "pixtral")
        return any(kw in lower for kw in vision_keywords)

    # ── Difficulty classification ──────────────────────────────────────

    # Keywords that signal complexity — each maps to the points it adds.
    _HARD_KEYWORDS: list[tuple[str, int]] = [
        # Expert-level (3 pts)
        ("refactor", 3), ("architect", 3), ("redesign", 3), ("migrate", 3),
        ("security vulnerability", 3), ("race condition", 3), ("concurrency", 3),
        ("microservice", 3), ("infrastructure", 3), ("distributed", 3),
        # Hard (2 pts)
        ("implement", 2), ("debug", 2), ("optimize", 2), ("fix the bug", 2),
        ("stack trace", 2), ("traceback", 2), ("error:", 2), ("exception", 2),
        ("multi-step", 2), ("step by step", 2), ("algorithm", 2),
        ("integrate", 2), ("authentication", 2), ("database", 2),
        ("deploy", 2), ("pipeline", 2), ("performance", 2),
        # Medium (1 pt)
        ("explain", 1), ("how does", 1), ("write a", 1), ("create a", 1),
        ("update", 1), ("change", 1), ("modify", 1), ("add a", 1),
        ("search for", 1), ("find", 1), ("look up", 1), ("open", 1),
    ]

    _EASY_SIGNALS: list[str] = [
        "hi", "hello", "hey", "thanks", "thank you", "ok", "okay", "sure",
        "yes", "no", "good", "great", "bye", "gn", "gm", "lol", "haha",
        "what time", "how are you", "what's up", "love you",
    ]
    def _classify_difficulty(self, messages: list[dict[str, Any]]) -> str:
        """
        Classify the current turn's difficulty based on conversation context.

        Returns one of: "easy", "medium", "hard", "expert".

        The classifier uses a point-based system on the latest user message
        plus conversation-level signals (tool-call depth, code blocks, etc.).
        Thresholds:  easy = greeting/casual,  medium = 0-2,  hard = 3-7,
        expert = 8+.
        """
        import re as _re

        # Find the last user message
        last_user = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, list):
                    last_user = " ".join(
                        item.get("text", "") for item in content
                        if isinstance(item, dict)
                    )
                else:
                    last_user = str(content)
                break

        lower = last_user.lower().strip()
        words = set(_re.findall(r"[a-z']+", lower))

        # Quick exit: very short casual messages → easy
        # Use word-set intersection to avoid "no" matching "now", etc.
        if len(lower) < 40:
            easy_words = {"hi", "hello", "hey", "thanks", "ok", "okay", "sure",
                          "yes", "no", "good", "great", "bye", "gn", "gm",
                          "lol", "haha"}
            easy_phrases = {"thank you", "how are you", "what's up",
                            "love you", "what time"}
            if words & easy_words or any(p in lower for p in easy_phrases):
                return "easy"

        score = 0

        # ── Text complexity signals ──
        if len(last_user) > 500:
            score += 2
        elif len(last_user) > 200:
            score += 1

        # Code blocks (strong signal of technical task)
        score += min(last_user.count("```"), 3) * 2

        # Multiple questions
        question_count = last_user.count("?")
        if question_count >= 3:
            score += 2
        elif question_count >= 2:
            score += 1

        # Numbered lists / multi-step instructions
        numbered_steps = len(_re.findall(r"(?:^|\n)\s*\d+[.)]\s", last_user))
        if numbered_steps >= 3:
            score += 3
        elif numbered_steps >= 2:
            score += 1

        # Bullet points
        bullet_count = len(_re.findall(r"(?:^|\n)\s*[-*]\s", last_user))
        if bullet_count >= 3:
            score += 2

        # Keyword scoring — simple additive, each keyword adds its full weight
        for keyword, points in self._HARD_KEYWORDS:
            if keyword in lower:
                score += points
        # ── Conversation context signals ──
        last_user_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break
        turn_slice = messages[last_user_idx + 1 :] if last_user_idx >= 0 else messages

        tool_call_count = sum(
            1 for m in turn_slice
            if m.get("role") == "assistant" and m.get("tool_calls")
        )

        # Active tool-use chain → task is already complex
        if tool_call_count >= 3:
            score += 3
        elif tool_call_count >= 1:
            score += 1

        # If we're mid-chain processing tool results, bump slightly
        if turn_slice and turn_slice[-1].get("role") == "tool":
            score += 1

        # Map score to tier.
        # easy is only reached via the greeting fast-path above.
        # Everything else defaults to medium at minimum.
        if score <= 2:
            return "medium"
        elif score <= 6:
            return "hard"
        else:
            return "expert"

    def _select_model_for_difficulty(self, messages: list[dict[str, Any]], explicit_model: str | None) -> str:
        """Pick the right model based on difficulty when model_tiers is configured."""
        # If caller explicitly passed a model, respect it
        if explicit_model:
            return explicit_model

        # If no tiers configured, use default
        if not self.model_tiers:
            return self.default_model

        difficulty = self._classify_difficulty(messages)
        selected = self.model_tiers.get(difficulty) or self.default_model
        return selected

    # ── Main chat entry point ───────────────────────────────────────

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
    ) -> LLMResponse:
        """
        Send a chat completion request via LiteLLM.

        When ``model_tiers`` are configured, the difficulty of the current turn
        is classified and the appropriate model tier is selected automatically.
        On provider-level failures the fallback chain is tried.
        """
        primary = self._select_model_for_difficulty(messages, model)
        models_to_try = [primary] + [m for m in self.fallback_models if m != primary]

        last_error: Exception | None = None
        for attempt_model in models_to_try:
            try:
                return await self._chat_single(
                    messages=messages,
                    tools=tools,
                    model=attempt_model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            except Exception as e:
                last_error = e
                if not self._is_fallback_worthy(e):
                    return LLMResponse(
                        content=f"Error calling LLM: {e}",
                        finish_reason="error",
                    )

        return LLMResponse(
            content=f"Error calling LLM (all models failed): {last_error}",
            finish_reason="error",
        )

    @staticmethod
    def _is_fallback_worthy(exc: Exception) -> bool:
        """Return True when the error warrants trying the next fallback model."""
        err = str(exc).lower()
        return any(s in err for s in (
            "rate limit",
            "rate_limit",
            "429",
            "quota",
            "internal server error",
            "status code 500",
            '"code":500',
            "service unavailable",
            "503",
            "gateway timeout",
            "bad gateway",
            "timed out",
            "timeout",
            "temporarily unavailable",
            "connection reset",
            "overloaded",
            "capacity",
        ))

    async def _chat_single(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        max_tokens: int,
        temperature: float,
    ) -> LLMResponse:
        """Attempt a single model. Raises on provider-level failures."""
        original_model = model
        model = self._resolve_model(original_model)

        if self._supports_cache_control(original_model):
            messages, tools = self._apply_cache_control(messages, tools)

        max_tokens = max(1, max_tokens)

        kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._sanitize_messages(self._sanitize_empty_content(messages)),
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        self._apply_model_overrides(model, kwargs)

        if self.api_key:
            kwargs["api_key"] = self.api_key
        if self.api_base:
            kwargs["api_base"] = self.api_base
        if self.extra_headers:
            kwargs["extra_headers"] = self.extra_headers

        # For fallback models on a different provider, resolve their API key.
        self._inject_fallback_credentials(original_model, kwargs)

        # Groq models frequently emit invalid native function-call payloads.
        if tools and self._prefer_text_tool_calls(model, original_model):
            try:
                return await self._retry_with_text_tools(kwargs, tools)
            except Exception:
                pass

        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        try:
            response = await self._acompletion_with_retries(kwargs)
            return self._parse_response(response)
        except Exception as e:
            salvaged = self._try_salvage_tool_call(e)
            if salvaged:
                return salvaged

            if tools and self._is_tool_call_failure(e):
                try:
                    return await self._retry_with_text_tools(kwargs, tools)
                except Exception:
                    pass

            raise  # Let chat() handle fallback

    def _inject_fallback_credentials(self, model: str, kwargs: dict[str, Any]) -> None:
        """For fallback models, look up the correct API key from config."""
        if model == self.default_model:
            return
        try:
            from nanobot.config.loader import load_config
            config = load_config()
            provider_cfg = config.get_provider(model)
            if provider_cfg and provider_cfg.api_key:
                kwargs["api_key"] = provider_cfg.api_key
                api_base = config.get_api_base(model)
                if api_base:
                    kwargs["api_base"] = api_base
        except Exception:
            pass  # Fall back to default credentials

    @staticmethod
    def _is_tool_call_failure(exc: Exception) -> bool:
        """Check if the exception is a tool call formatting failure."""
        err = str(exc).lower()
        return any(s in err for s in (
            "tool_use_failed",
            "failed to call a function",
            "failed_generation",
            "tool call validation failed",
        ))

    @staticmethod
    def _is_transient_provider_failure(exc: Exception) -> bool:
        """Return True when the provider error looks transient/retryable."""
        err = str(exc).lower()
        return any(s in err for s in (
            "internal server error",
            '"code":500',
            "status code 500",
            "service unavailable",
            "gateway timeout",
            "bad gateway",
            "timed out",
            "timeout",
            "temporarily unavailable",
            "connection reset",
        ))

    async def _acompletion_with_retries(
        self,
        kwargs: dict[str, Any],
        retries: int = 2,
    ) -> Any:
        """Call LiteLLM with short retries for transient provider failures."""
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                return await acompletion(**kwargs)
            except Exception as exc:
                last_error = exc
                if attempt >= retries or not self._is_transient_provider_failure(exc):
                    raise
                await asyncio.sleep(0.75 * (2 ** attempt))
        if last_error:
            raise last_error
        raise RuntimeError("acompletion failed without an exception")

    @staticmethod
    def _prefer_text_tool_calls(model: str, original_model: str) -> bool:
        """Return True for model/provider combos with flaky native tool calls."""
        joined = f"{model} {original_model}".lower()
        return "groq/" in joined or " groq" in joined

    @staticmethod
    def _strip_native_tool_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert tool-heavy transcripts into plain chat messages for retry."""
        cleaned: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role")
            if role == "tool":
                content = msg.get("content", "")
                if isinstance(content, list):
                    content = json.dumps(content, ensure_ascii=False)
                elif content is None:
                    content = ""
                cleaned.append(
                    {
                        "role": "assistant",
                        "content": f"Tool result ({msg.get('name', 'tool')}): {content}",
                    }
                )
                continue

            if role == "assistant":
                content = msg.get("content")
                if not content:
                    # Skip assistant stubs that only carried tool_calls.
                    continue
                cleaned.append({"role": "assistant", "content": content})
                continue

            # Keep user/system with plain role + content only.
            if role in {"system", "user"}:
                cleaned.append({"role": role, "content": msg.get("content", "")})

        return cleaned

    @staticmethod
    def _tools_to_text_instruction(tools: list[dict[str, Any]]) -> str:
        """Convert tool definitions into a text instruction for the model."""
        lines = [
            "IMPORTANT: You must call tools by outputting EXACTLY this JSON format "
            "(no markdown, no code fences, just raw JSON on its own line):",
            '{"tool_call": {"name": "TOOL_NAME", "arguments": {ARGS}}}',
            "",
            "Available tools:",
        ]
        for tool in tools:
            func = tool.get("function", tool)
            name = func.get("name", "unknown")
            desc = func.get("description", "")
            params = func.get("parameters", {})
            props = params.get("properties", {})
            required = params.get("required", [])
            param_strs = []
            for pname, pdef in props.items():
                req = " (required)" if pname in required else ""
                param_strs.append(f'    "{pname}": {pdef.get("type", "string")}{req} — {pdef.get("description", "")}')
            lines.append(f"- {name}: {desc}")
            if param_strs:
                lines.append("  Parameters:")
                lines.extend(param_strs)
        lines.append("")
        lines.append("After the tool runs, you'll see the result and can respond to the user.")
        return "\n".join(lines)

    async def _retry_with_text_tools(
        self,
        original_kwargs: dict[str, Any],
        tools: list[dict[str, Any]],
    ) -> LLMResponse:
        """Retry a failed tool-call request using text-based tool descriptions.

        Strips native ``tools``/``tool_choice`` from the request and injects a
        system message that tells the model to output tool calls as JSON text.
        The response is then scanned for parseable tool-call JSON.
        """
        retry_kwargs = dict(original_kwargs)
        retry_kwargs.pop("tools", None)
        retry_kwargs.pop("tool_choice", None)
        retry_kwargs["temperature"] = 0

        # Inject tool-as-text instruction before the last user message
        tool_instruction = self._tools_to_text_instruction(tools)
        messages = self._strip_native_tool_messages(list(retry_kwargs["messages"]))
        insert_at = len(messages)
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                insert_at = i
                break
        messages.insert(insert_at, {"role": "system", "content": tool_instruction})
        retry_kwargs["messages"] = self._sanitize_messages(messages)

        response = await self._acompletion_with_retries(retry_kwargs)
        result = self._parse_response(response)

        # Try to extract tool calls from the plain-text response
        if result.content and not result.tool_calls:
            parsed = self._parse_text_tool_calls(result.content)
            if parsed:
                # Strip the JSON from displayed content
                clean = result.content
                for tc in parsed:
                    # Remove the JSON line from the content
                    clean = re.sub(
                        r'\{["\s]*tool_call["\s]*:.*?\}\s*\}',
                        "",
                        clean,
                        count=1,
                        flags=re.DOTALL,
                    )
                result = LLMResponse(
                    content=clean.strip() or None,
                    tool_calls=parsed,
                    finish_reason="tool_calls",
                    usage=result.usage,
                )

        return result

    @staticmethod
    def _parse_text_tool_calls(text: str) -> list[ToolCallRequest]:
        """Extract tool calls from model text output.

        Looks for JSON like: {"tool_call": {"name": "exec", "arguments": {...}}}
        Also handles bare: {"name": "exec", "arguments": {...}}
        """
        calls: list[ToolCallRequest] = []

        # Pattern 1: {"tool_call": {"name": ..., "arguments": ...}}
        for match in re.finditer(r'\{\s*"tool_call"\s*:\s*(\{.*?\})\s*\}', text, re.DOTALL):
            try:
                inner = json_repair.loads(match.group(1))
                if isinstance(inner, dict) and "name" in inner:
                    calls.append(ToolCallRequest(
                        id=f"text_{uuid.uuid4().hex[:8]}",
                        name=inner["name"],
                        arguments=inner.get("arguments", {}),
                    ))
            except Exception:
                continue

        if calls:
            return calls

        # Pattern 2: bare {"name": "tool", "arguments": {...}}
        for match in re.finditer(r'\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{.*?\})\s*\}', text, re.DOTALL):
            try:
                args = json_repair.loads(match.group(2))
                calls.append(ToolCallRequest(
                    id=f"text_{uuid.uuid4().hex[:8]}",
                    name=match.group(1),
                    arguments=args if isinstance(args, dict) else {},
                ))
            except Exception:
                continue

        return calls

    @staticmethod
    def _try_salvage_tool_call(exc: Exception) -> LLMResponse | None:
        """Attempt to parse a tool call from a provider error.

        Some models (e.g. Llama 3.x on Groq) emit tool calls in an XML-like
        format that the provider API rejects:
            <function=exec{"command": "start chrome"}></function>
        The error JSON often includes ``failed_generation`` with the raw text.
        We extract the tool name and arguments so the agent loop can still
        execute the tool.
        """
        err_str = str(exc)
        if "tool_use_failed" not in err_str and "failed_generation" not in err_str:
            return None

        # Try to extract the failed_generation from the error JSON
        # Pattern: <function=TOOLNAME{JSON_ARGS}></function>
        # Also handle: <function=TOOLNAME>{"key": "value"}</function>
        patterns = [
            r"<function=(\w+)(\{.*?\})>\s*</function>",       # <function=exec{"cmd":"x"}></function>
            r"<function=(\w+)>\s*(\{.*?\})\s*</function>",    # <function=exec>{"cmd":"x"}</function>
        ]

        for pattern in patterns:
            match = re.search(pattern, err_str, re.DOTALL)
            if match:
                tool_name = match.group(1)
                try:
                    args = json_repair.loads(match.group(2))
                except Exception:
                    continue
                if isinstance(args, dict):
                    return LLMResponse(
                        content=None,
                        tool_calls=[ToolCallRequest(
                            id=f"salvaged_{uuid.uuid4().hex[:8]}",
                            name=tool_name,
                            arguments=args,
                        )],
                        finish_reason="tool_calls",
                    )

        return None

    def _parse_response(self, response: Any) -> LLMResponse:
        """Parse LiteLLM response into our standard format."""
        choice = response.choices[0]
        message = choice.message
        
        tool_calls = []
        if hasattr(message, "tool_calls") and message.tool_calls:
            for tc in message.tool_calls:
                # Parse arguments from JSON string if needed
                args = tc.function.arguments
                if isinstance(args, str):
                    args = json_repair.loads(args)
                
                tool_calls.append(ToolCallRequest(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=args,
                ))
        
        usage = {}
        if hasattr(response, "usage") and response.usage:
            usage = {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            }
        
        reasoning_content = getattr(message, "reasoning_content", None) or None
        
        return LLMResponse(
            content=message.content,
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            usage=usage,
            reasoning_content=reasoning_content,
        )
    
    def get_default_model(self) -> str:
        """Get the default model."""
        return self.default_model

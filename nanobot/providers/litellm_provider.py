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
    ):
        super().__init__(api_key, api_base)
        self.default_model = default_model
        self.extra_headers = extra_headers or {}
        
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
        
        Args:
            messages: List of message dicts with 'role' and 'content'.
            tools: Optional list of tool definitions in OpenAI format.
            model: Model identifier (e.g., 'anthropic/claude-sonnet-4-5').
            max_tokens: Maximum tokens in response.
            temperature: Sampling temperature.
        
        Returns:
            LLMResponse with content and/or tool calls.
        """
        original_model = model or self.default_model
        model = self._resolve_model(original_model)

        if self._supports_cache_control(original_model):
            messages, tools = self._apply_cache_control(messages, tools)

        # Clamp max_tokens to at least 1 — negative or zero values cause
        # LiteLLM to reject the request with "max_tokens must be at least 1".
        max_tokens = max(1, max_tokens)
        
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._sanitize_messages(self._sanitize_empty_content(messages)),
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        
        # Apply model-specific overrides (e.g. kimi-k2.5 temperature)
        self._apply_model_overrides(model, kwargs)
        
        # Pass api_key directly — more reliable than env vars alone
        if self.api_key:
            kwargs["api_key"] = self.api_key
        
        # Pass api_base for custom endpoints
        if self.api_base:
            kwargs["api_base"] = self.api_base
        
        # Pass extra headers (e.g. APP-Code for AiHubMix)
        if self.extra_headers:
            kwargs["extra_headers"] = self.extra_headers

        # Groq models frequently emit invalid native function-call payloads.
        # Prefer text-based tool calls up front for higher reliability.
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
            # Some models (Llama on Groq) generate malformed tool calls in XML
            # format like <function=exec{"command":"..."}></function> which the
            # provider rejects.  Try to salvage the tool call from the error.
            salvaged = self._try_salvage_tool_call(e)
            if salvaged:
                return salvaged

            # If native tool calling failed, retry with text-based tool
            # descriptions so the model outputs JSON we can parse instead.
            if tools and self._is_tool_call_failure(e):
                try:
                    return await self._retry_with_text_tools(kwargs, tools)
                except Exception:
                    pass  # Fall through to error return

            # Return error as content for graceful handling
            return LLMResponse(
                content=f"Error calling LLM: {str(e)}",
                finish_reason="error",
            )
    
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

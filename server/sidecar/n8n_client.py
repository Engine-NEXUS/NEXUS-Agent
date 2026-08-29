"""
n8n supervisor client.

Calls the n8n master supervisor webhook with the transcript + user credentials,
reads the streamed response, and returns the final result text.

The supervisor webhook is expected to:
  1. Classify intent (via Ollama).
  2. Route to the appropriate sub-canvas (Execute Sub-workflow).
  3. Return a structured result or streamed text.

If n8n is configured with responseMode=streaming + AI Agent node, we read
SSE-style chunks and accumulate the response.
"""

from __future__ import annotations

import os
import json
import logging
from typing import AsyncIterator

import httpx

log = logging.getLogger("NEXUS.sidecar.n8n")

N8N_SUPERVISOR_URL = os.getenv("N8N_SUPERVISOR_URL", "http://localhost:5678/webhook/supervisor")
N8N_STREAM_URL = os.getenv("N8N_STREAM_URL", "http://localhost:5678/webhook-stream/supervisor")
# n8n API token for authenticating webhook calls (if the supervisor uses Auth Check).
N8N_API_TOKEN = os.getenv("N8N_API_TOKEN", "")


async def call_supervisor(
    session_id: str,
    user_id: str,
    device_id: str,
    transcript: str,
    credentials: dict,
    use_streaming: bool = True,
) -> str:
    """
    Call the n8n supervisor and return the final result text.

    Args:
        session_id: The NEXUS session ID for correlation.
        user_id: The user's ID (for credential lookup).
        device_id: The device ID.
        transcript: The transcribed user speech.
        credentials: The user's OAuth tokens + API keys (from oauth.get_valid_credentials).
        use_streaming: If True, use the streaming webhook endpoint.

    Returns:
        The final response text from n8n.
    """
    payload = {
        "transcript": transcript,
        "sessionId": session_id,
        "userId": user_id,
        "deviceId": device_id,
        "credentials": credentials,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {N8N_API_TOKEN}" if N8N_API_TOKEN else "",
    }
    # Remove empty auth header.
    if not headers["Authorization"]:
        headers.pop("Authorization")

    url = N8N_STREAM_URL if use_streaming else N8N_SUPERVISOR_URL
    if use_streaming:
        headers["Accept"] = "text/event-stream"

    collected: list[str] = []

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            if use_streaming:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        # n8n streaming emits SSE-style "data: {...}" lines.
                        if line.startswith("data:"):
                            line = line[5:].strip()
                        try:
                            evt = json.loads(line)
                        except json.JSONDecodeError:
                            # Plain text chunk.
                            collected.append(line)
                            continue
                        # Accumulate token/text deltas from AI Agent streaming.
                        for key in ("token", "text", "reply_text", "content", "output"):
                            if key in evt:
                                collected.append(str(evt[key]))
                                break
            else:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                # The supervisor returns structured JSON; extract the text.
                if isinstance(data, dict):
                    collected.append(
                        data.get("reply_text")
                        or data.get("text")
                        or data.get("content")
                        or data.get("summary")
                        or data.get("response")
                        or json.dumps(data)
                    )
                elif isinstance(data, str):
                    collected.append(data)
    except httpx.HTTPStatusError as e:
        log.exception("n8n supervisor returned error: %s", e.response.text)
        return f"Sorry, I couldn't reach the workflow server. Error: {e.response.status_code}"
    except Exception:
        log.exception("n8n supervisor call failed")
        return "Sorry, the workflow server is unavailable."

    return "".join(collected).strip()

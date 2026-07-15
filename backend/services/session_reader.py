"""Read persisted pi session messages without activating the runtime."""

from __future__ import annotations

import json
from pathlib import Path

from config import get_sessions_dir


def find_session_file(session_id: str, cwd: str | Path) -> Path | None:
    root = get_sessions_dir(str(cwd))
    if not root.exists():
        return None
    for path in root.rglob("*.jsonl"):
        try:
            with path.open(encoding="utf-8") as handle:
                header = json.loads(handle.readline())
            if header.get("type") == "session" and header.get("id") == session_id:
                return path
        except (OSError, json.JSONDecodeError):
            continue
    return None


def read_session_messages(session_id: str, cwd: str | Path) -> list[dict]:
    path = find_session_file(session_id, cwd)
    if path is None:
        return []
    messages: list[dict] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "message":
                    continue
                message = entry.get("message", {})
                messages.append({
                    "id": entry.get("id", ""),
                    "role": message.get("role", ""),
                    "content": message.get("content", []),
                    "timestamp": entry.get("timestamp"),
                })
    except OSError:
        return []
    return messages


def message_text(message: dict, max_chars: int = 12000) -> str:
    chunks: list[str] = []
    for part in message.get("content", []):
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            chunks.append(part["text"])
        elif part.get("type") in {"toolCall", "toolResult"}:
            name = part.get("name") or part.get("tool") or part.get("toolName") or "tool"
            chunks.append(f"[{part.get('type')}: {name}]")
    return "\n".join(chunks)[:max_chars]

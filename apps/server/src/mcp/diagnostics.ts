export function redactMcpError(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s"')]+/gi, (raw) => { try { return new URL(raw).origin; } catch { return "[redacted-url]"; } });
}


import { randomUUID, createHash } from "node:crypto";

export function createId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(input: string | Uint8Array) {
  return createHash("sha256").update(input).digest("hex");
}

export function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

export function roundScore(value: number, precision = 4) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function coerceErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

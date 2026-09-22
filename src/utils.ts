export const SESSION_COOKIE = "gateway_session";
export const CSRF_COOKIE = "gateway_csrf";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export const PROTOCOLS = [
  "vless-ws",
  "xhttp-packet-up",
  "xhttp-stream-up",
  "xhttp-stream-one",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export const FINGERPRINTS = [
  "chrome",
  "firefox",
  "safari",
  "ios",
  "android",
  "edge",
  "360",
  "qq",
  "random",
  "randomized",
] as const;

export const DEFAULT_PROTOCOL: Protocol = "vless-ws";
export const DEFAULT_FINGERPRINT = "chrome";
export const DEFAULT_PORT = 443;
export const DEFAULT_SPEED_LIMIT = 0;

export const DEFAULT_ALPN_BY_PROTOCOL: Record<string, string> = {
  "vless-ws": "http/1.1",
  "xhttp-packet-up": "h2,http/1.1",
  "xhttp-stream-up": "h2,http/1.1",
  "xhttp-stream-one": "h2,http/1.1",
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function html(content: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(content, { ...init, headers });
}

export function text(content: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(content, { ...init, headers });
}

export function errorResponse(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a[i] ^ b[i];
  return result === 0;
}

export async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }
  return cookies;
}

export function appendCookie(headers: Headers, value: string): void {
  headers.append("set-cookie", value);
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
    expires?: Date;
  } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  return parts.join("; ");
}

export function clearCookie(name: string, secure = true): string {
  return serializeCookie(name, "", { maxAge: 0, secure, expires: new Date(0) });
}

export function parseSizeToBytes(value: unknown, unit: unknown): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  switch (String(unit || "").toUpperCase()) {
    case "GB": return Math.floor(numeric * 1024 ** 3);
    case "MB": return Math.floor(numeric * 1024 ** 2);
    case "KB": return Math.floor(numeric * 1024);
    default: return Math.floor(numeric);
  }
}

export function parseSpeedToBytes(value: unknown, unit: unknown): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  switch (String(unit || "MBIT").toUpperCase()) {
    case "MBIT":
    case "MBPS": return Math.floor(numeric * 1024 * 1024 / 8);
    case "MB": return Math.floor(numeric * 1024 ** 2);
    case "KB": return Math.floor(numeric * 1024);
    default: return Math.floor(numeric);
  }
}

export function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function isExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getPublicOrigin(request: Request, env: { PUBLIC_ORIGIN?: string }): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const url = new URL(request.url);
  return url.origin;
}

export function getClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export function parseInteger(value: unknown, fallback = 0): number {
  const result = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(result) ? result : fallback;
}

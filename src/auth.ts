import type { Env } from "./database";
import { first, logActivity, run } from "./database";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  appendCookie,
  base64Url,
  clearCookie,
  equalBytes,
  fromBase64Url,
  hmacSha256,
  json,
  nowIso,
  parseCookies,
  randomToken,
  serializeCookie,
} from "./utils";
import { HttpError } from "./utils";

const PBKDF2_ITERATIONS = 150_000;

type AdminRow = {
  id: number;
  username: string;
  password_hash: string;
};

function requireSecret(env: Env): string {
  if (!env.SECRET_KEY) throw new HttpError(500, "SECRET_KEY is not configured");
  return env.SECRET_KEY;
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) return new Uint8Array(0);
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

async function derivePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bufferSource(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new HttpError(400, "password must contain at least 8 characters");
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const digest = await derivePassword(password, salt);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(digest)}`;
}

export async function verifyPassword(password: string, encoded: string, legacySecret?: string): Promise<boolean> {
  if (encoded.startsWith("legacy-sha256$") && legacySecret) {
    const expected = encoded.slice("legacy-sha256$".length);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${password}${legacySecret}`),
    );
    return equalBytes(new Uint8Array(digest), fromHex(expected));
  }
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) return false;
  try {
    const digest = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: bufferSource(fromBase64Url(parts[2])), iterations, hash: "SHA-256" },
      digest,
      256,
    );
    return equalBytes(new Uint8Array(bits), fromBase64Url(parts[3]));
  } catch {
    return false;
  }
}

async function ensureBootstrapAdmin(env: Env): Promise<void> {
  const existing = await first<AdminRow>(env, "SELECT id, username, password_hash FROM admins ORDER BY id LIMIT 1");
  if (existing) return;
  if (!env.ADMIN_PASSWORD) {
    throw new HttpError(503, "ADMIN_PASSWORD is not configured; set it before the first login");
  }
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  const timestamp = nowIso();
  await run(
    env,
    `INSERT OR IGNORE INTO admins (username, password_hash, created_at, updated_at)
     VALUES ('admin', ?, ?, ?)`,
    passwordHash,
    timestamp,
    timestamp,
  );
  await logActivity(env, "system", "initial admin account created", "ok");
}

export async function getAdmin(env: Env): Promise<AdminRow | null> {
  return first<AdminRow>(env, "SELECT id, username, password_hash FROM admins ORDER BY id LIMIT 1");
}

export async function login(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { password?: string };
  requireSecret(env);
  await ensureBootstrapAdmin(env);
  const admin = await getAdmin(env);
  const password = String(body.password || "");
  const valid = Boolean(admin && await verifyPassword(password, admin.password_hash, env.LEGACY_SECRET_KEY));
  if (!admin || !valid) {
    await logActivity(env, "auth", "failed admin login", "err");
    throw new HttpError(401, "رمز عبور اشتباه است");
  }
  if (admin.password_hash.startsWith("legacy-sha256$") && password.length >= 8) {
    await run(env, "UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?", await hashPassword(password), nowIso(), admin.id);
  }

  const sessionNonce = randomToken(32);
  const session = `${sessionNonce}.${await hmacSha256(requireSecret(env), sessionNonce)}`;
  const csrf = randomToken(24);
  await env.TEMP.put(`session:${session}`, String(admin.id), { expirationTtl: SESSION_TTL_SECONDS });
  await logActivity(env, "auth", "admin login", "ok");

  const secure = new URL(request.url).protocol === "https:";
  const response = json({ ok: true });
  appendCookie(response.headers, serializeCookie(SESSION_COOKIE, session, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    secure,
    sameSite: "Lax",
  }));
  appendCookie(response.headers, serializeCookie(CSRF_COOKIE, csrf, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: false,
    secure,
    sameSite: "Lax",
  }));
  return response;
}

export async function getSessionAdmin(request: Request, env: Env): Promise<AdminRow | null> {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token || !env.SECRET_KEY) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await hmacSha256(env.SECRET_KEY, nonce);
  if (!equalBytes(new TextEncoder().encode(signature), new TextEncoder().encode(expected))) return null;
  const adminId = await env.TEMP.get(`session:${token}`);
  if (!adminId) return null;
  return first<AdminRow>(env, "SELECT id, username, password_hash FROM admins WHERE id = ?", Number(adminId));
}

export async function requireAuth(request: Request, env: Env): Promise<AdminRow> {
  const admin = await getSessionAdmin(request, env);
  if (!admin) throw new HttpError(401, "unauthorized");
  return admin;
}

export async function requireCsrf(request: Request): Promise<void> {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const cookies = parseCookies(request);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken || !equalBytes(new TextEncoder().encode(cookieToken), new TextEncoder().encode(headerToken))) {
    throw new HttpError(403, "csrf validation failed");
  }
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request);
  if (cookies[SESSION_COOKIE]) await env.TEMP.delete(`session:${cookies[SESSION_COOKIE]}`);
  await logActivity(env, "auth", "admin logout", "info");
  const response = json({ ok: true });
  const secure = new URL(request.url).protocol === "https:";
  appendCookie(response.headers, clearCookie(SESSION_COOKIE, secure));
  appendCookie(response.headers, clearCookie(CSRF_COOKIE, secure));
  return response;
}

export async function changePassword(request: Request, env: Env, admin: AdminRow): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    current_password?: string;
    new_password?: string;
  };
  if (!(await verifyPassword(String(body.current_password || ""), admin.password_hash, env.LEGACY_SECRET_KEY))) {
    throw new HttpError(400, "رمز فعلی اشتباه است");
  }
  const passwordHash = await hashPassword(String(body.new_password || ""));
  await run(env, "UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?", passwordHash, nowIso(), admin.id);
  await logActivity(env, "auth", "admin password changed", "ok");
  return json({ ok: true });
}

export function authStatus(request: Request, env: Env): Promise<Response> {
  return getSessionAdmin(request, env).then((admin) => json({ authenticated: Boolean(admin) }));
}

export function addAuthHeaders(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

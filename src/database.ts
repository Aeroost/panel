import type { Protocol } from "./utils";
import { nowIso } from "./utils";

export interface Env {
  DB: D1Database;
  TEMP: KVNamespace;
  ASSETS?: Fetcher;
  ADMIN_PASSWORD?: string;
  SECRET_KEY?: string;
  LEGACY_SECRET_KEY?: string;
  PUBLIC_ORIGIN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_IDS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export interface LinkRecord {
  uuid: string;
  label: string;
  limit_bytes: number;
  used_bytes: number;
  created_at: string;
  active: boolean;
  expires_at: string | null;
  note: string;
  is_default: boolean;
  sub_id: string | null;
  protocol: Protocol;
  fingerprint: string;
  alpn: string;
  port: number;
  ip_limit: number;
  speed_limit_bytes: number;
}

export interface SubscriptionRecord {
  sub_id: string;
  name: string;
  description: string;
  password_hash: string | null;
  uuid_key: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityLog {
  id: number;
  kind: string;
  level: string;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

export function asLink(row: Record<string, unknown>): LinkRecord {
  return {
    uuid: String(row.uuid),
    label: String(row.label || "لینک جدید"),
    limit_bytes: Number(row.limit_bytes || 0),
    used_bytes: Number(row.used_bytes || 0),
    created_at: String(row.created_at),
    active: Boolean(row.active),
    expires_at: row.expires_at ? String(row.expires_at) : null,
    note: String(row.note || ""),
    is_default: Boolean(row.is_default),
    sub_id: row.sub_id ? String(row.sub_id) : null,
    protocol: String(row.protocol || "vless-ws") as Protocol,
    fingerprint: String(row.fingerprint || "chrome"),
    alpn: String(row.alpn || ""),
    port: Number(row.port || 443),
    ip_limit: Number(row.ip_limit || 0),
    speed_limit_bytes: Number(row.speed_limit_bytes || 0),
  };
}

export function asSubscription(row: Record<string, unknown>): SubscriptionRecord {
  return {
    sub_id: String(row.sub_id),
    name: String(row.name || "گروه جدید"),
    description: String(row.description || ""),
    password_hash: row.password_hash ? String(row.password_hash) : null,
    uuid_key: String(row.uuid_key),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function query<T extends Record<string, unknown>>(
  env: Env,
  sql: string,
  ...bindings: unknown[]
): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...bindings).all<T>();
  return result.results || [];
}

export async function first<T extends Record<string, unknown>>(
  env: Env,
  sql: string,
  ...bindings: unknown[]
): Promise<T | null> {
  const result = await env.DB.prepare(sql).bind(...bindings).first<T>();
  return result || null;
}

export async function run(env: Env, sql: string, ...bindings: unknown[]): Promise<D1Result> {
  return env.DB.prepare(sql).bind(...bindings).run();
}

export async function logActivity(
  env: Env,
  kind: string,
  message: string,
  level = "info",
  metadata?: unknown,
): Promise<void> {
  await run(
    env,
    `INSERT INTO logs (kind, level, message, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    kind,
    level,
    message,
    metadata === undefined ? null : JSON.stringify(metadata),
    nowIso(),
  );
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(env, "SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await run(
    env,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    nowIso(),
  );
}

export async function countActiveConnections(env: Env): Promise<number> {
  const row = await first<{ count: number }>(
    env,
    "SELECT COUNT(*) AS count FROM connections WHERE status = 'active'",
  );
  return Number(row?.count || 0);
}

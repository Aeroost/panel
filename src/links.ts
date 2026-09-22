import type { Env, LinkRecord } from "./database";
import type { Protocol } from "./utils";
import { asLink, first, logActivity, query, run } from "./database";
import {
  DEFAULT_ALPN_BY_PROTOCOL,
  DEFAULT_FINGERPRINT,
  DEFAULT_PORT,
  DEFAULT_PROTOCOL,
  FINGERPRINTS,
  HttpError,
  PROTOCOLS,
  formatBytes,
  getPublicOrigin,
  isExpired,
  json,
  nowIso,
  parseInteger,
  parseSizeToBytes,
  parseSpeedToBytes,
  readJson,
} from "./utils";

export interface LinkResponse extends LinkRecord {
  expired: boolean;
  connected_ips: number;
  vless_link: string;
  sub_url: string;
}

export function linkAllowed(link: LinkRecord | null): boolean {
  if (!link || !link.active || isExpired(link.expires_at)) return false;
  return link.limit_bytes <= 0 || link.used_bytes < link.limit_bytes;
}

export function generateVlessLink(link: LinkRecord, origin: string): string {
  const parsedOrigin = new URL(origin);
  const host = parsedOrigin.hostname.includes(":") ? `[${parsedOrigin.hostname}]` : parsedOrigin.hostname;
  const protocol = PROTOCOLS.includes(link.protocol) ? link.protocol : DEFAULT_PROTOCOL;
  const fingerprint = FINGERPRINTS.includes(link.fingerprint as typeof FINGERPRINTS[number])
    ? link.fingerprint
    : DEFAULT_FINGERPRINT;
  const alpn = link.alpn || DEFAULT_ALPN_BY_PROTOCOL[protocol] || "http/1.1";
  const port = DEFAULT_PORT;
  const params = new URLSearchParams({
    encryption: "none",
    security: "tls",
    host,
    sni: host,
    fp: fingerprint,
    alpn,
  });
  let path: string;
  if (protocol === "vless-ws") {
    params.set("type", "ws");
    path = `/ws/${link.uuid}`;
  } else {
    params.set("type", "xhttp");
    const mode = protocol.replace("xhttp-", "");
    params.set("mode", mode);
    path = `/xhttp-siz10/${mode}/${link.uuid}`;
  }
  params.set("path", path);
  return `vless://${link.uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(`Gateway-${link.label}`)}`;
}

function normalizeProtocol(value: unknown): Protocol {
  const candidate = String(value || DEFAULT_PROTOCOL) as Protocol;
  return PROTOCOLS.includes(candidate) ? candidate : DEFAULT_PROTOCOL;
}

function normalizeFingerprint(value: unknown): string {
  const candidate = String(value || DEFAULT_FINGERPRINT).trim().toLowerCase();
  return FINGERPRINTS.includes(candidate as typeof FINGERPRINTS[number]) ? candidate : DEFAULT_FINGERPRINT;
}

function buildExpiry(days: unknown): string | null {
  const number = parseInteger(days, 0);
  if (number <= 0) return null;
  return new Date(Date.now() + number * 86400_000).toISOString();
}

function inputToLink(body: Record<string, unknown>, existing?: LinkRecord): Omit<LinkRecord, "created_at"> {
  const label = String(body.label ?? existing?.label ?? "لینک جدید").trim().slice(0, 60) || "لینک جدید";
  const limitBytes = body.limit_value !== undefined
    ? parseSizeToBytes(body.limit_value, body.limit_unit || "GB")
    : (existing?.limit_bytes || 0);
  const speedLimit = body.speed_limit_value !== undefined
    ? parseSpeedToBytes(body.speed_limit_value, body.speed_limit_unit || "MBIT")
    : (existing?.speed_limit_bytes || 0);
  return {
    uuid: existing?.uuid || crypto.randomUUID(),
    label,
    limit_bytes: Math.max(0, limitBytes),
    used_bytes: existing?.used_bytes || 0,
    active: body.active === undefined ? (existing?.active ?? true) : Boolean(body.active),
    expires_at: body.expires_days !== undefined ? buildExpiry(body.expires_days) : (existing?.expires_at || null),
    note: String(body.note ?? existing?.note ?? "").trim().slice(0, 200),
    is_default: existing?.is_default || false,
    sub_id: body.sub_id === undefined ? (existing?.sub_id || null) : (body.sub_id ? String(body.sub_id) : null),
    protocol: normalizeProtocol(body.protocol ?? existing?.protocol),
    fingerprint: normalizeFingerprint(body.fingerprint ?? existing?.fingerprint),
    alpn: String(body.alpn ?? existing?.alpn ?? "").trim().slice(0, 100),
    port: DEFAULT_PORT,
    ip_limit: Math.max(0, parseInteger(body.ip_limit ?? existing?.ip_limit, 0)),
    speed_limit_bytes: Math.max(0, speedLimit),
  };
}

export async function findLink(env: Env, uuid: string): Promise<LinkRecord | null> {
  const row = await first<Record<string, unknown>>(env, "SELECT * FROM links WHERE uuid = ?", uuid);
  return row ? asLink(row) : null;
}

export async function listLinks(env: Env, request: Request): Promise<LinkResponse[]> {
  const origin = getPublicOrigin(request, env);
  const rows = await query<Record<string, unknown>>(env, "SELECT * FROM links ORDER BY created_at DESC");
  return rows.map((row) => {
    const link = asLink(row);
    return {
      ...link,
      expired: isExpired(link.expires_at),
      connected_ips: 0,
      vless_link: generateVlessLink(link, origin),
      sub_url: `${origin}/sub/${link.uuid}`,
    };
  });
}

export async function createLink(env: Env, request: Request): Promise<LinkResponse> {
  const body = await readJson<Record<string, unknown>>(request);
  const data = inputToLink(body);
  const createdAt = nowIso();
  if (data.sub_id) {
    const sub = await first(env, "SELECT sub_id FROM subscriptions WHERE sub_id = ?", data.sub_id);
    if (!sub) throw new HttpError(400, "subscription group not found");
  }
  await run(
    env,
    `INSERT INTO links
      (uuid, label, limit_bytes, used_bytes, created_at, active, expires_at, note, is_default,
       sub_id, protocol, fingerprint, alpn, port, ip_limit, speed_limit_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.uuid,
    data.label,
    data.limit_bytes,
    data.used_bytes,
    createdAt,
    data.active ? 1 : 0,
    data.expires_at,
    data.note,
    data.is_default ? 1 : 0,
    data.sub_id,
    data.protocol,
    data.fingerprint,
    data.alpn,
    data.port,
    data.ip_limit,
    data.speed_limit_bytes,
  );
  await logActivity(env, "link", `link created: ${data.label}`, "ok");
  const link = await findLink(env, data.uuid);
  if (!link) throw new HttpError(500, "link creation failed");
  const origin = getPublicOrigin(request, env);
  return {
    ...link,
    expired: false,
    connected_ips: 0,
    vless_link: generateVlessLink(link, origin),
    sub_url: `${origin}/sub/${link.uuid}`,
  };
}

export async function updateLink(env: Env, request: Request, uuid: string): Promise<Response> {
  const current = await findLink(env, uuid);
  if (!current) throw new HttpError(404, "link not found");
  const body = await readJson<Record<string, unknown>>(request);
  const updated = inputToLink(body, current);
  const active = body.active === undefined ? current.active : Boolean(body.active);
  const usedBytes = body.reset_usage ? 0 : current.used_bytes;
  const subId = body.sub_id === undefined ? current.sub_id : (body.sub_id ? String(body.sub_id) : null);
  if (subId) {
    const sub = await first(env, "SELECT sub_id FROM subscriptions WHERE sub_id = ?", subId);
    if (!sub) throw new HttpError(400, "subscription group not found");
  }
  await run(
    env,
    `UPDATE links SET label = ?, limit_bytes = ?, used_bytes = ?, active = ?, expires_at = ?, note = ?,
       sub_id = ?, protocol = ?, fingerprint = ?, alpn = ?, port = ?, ip_limit = ?, speed_limit_bytes = ?
     WHERE uuid = ?`,
    updated.label,
    updated.limit_bytes,
    usedBytes,
    active ? 1 : 0,
    updated.expires_at,
    updated.note,
    subId,
    updated.protocol,
    updated.fingerprint,
    updated.alpn,
    updated.port,
    updated.ip_limit,
    updated.speed_limit_bytes,
    uuid,
  );
  await logActivity(env, "link", `link updated: ${updated.label}`, "info");
  return json({ ok: true });
}

export async function deleteLink(env: Env, uuid: string): Promise<Response> {
  const link = await findLink(env, uuid);
  if (!link) throw new HttpError(404, "link not found");
  await run(env, "DELETE FROM links WHERE uuid = ?", uuid);
  await logActivity(env, "link", `link deleted: ${link.label}`, "warn");
  return json({ ok: true, deleted: uuid });
}

export async function ensureDefaultLink(env: Env): Promise<void> {
  const row = await first<{ uuid: string }>(env, "SELECT uuid FROM links WHERE is_default = 1 LIMIT 1");
  if (row) return;
  const uuid = crypto.randomUUID();
  const timestamp = nowIso();
  await run(
    env,
    `INSERT OR IGNORE INTO links
      (uuid, label, limit_bytes, used_bytes, created_at, active, expires_at, note, is_default,
       sub_id, protocol, fingerprint, alpn, port, ip_limit, speed_limit_bytes)
     VALUES (?, ?, 0, 0, ?, 1, NULL, '', 1, NULL, 'vless-ws', 'chrome', '', 443, 0, 0)`,
    uuid,
    "لینک پیش‌فرض",
    timestamp,
  );
  await logActivity(env, "system", "default link created", "ok");
}

export async function getAllowedLink(env: Env, uuid: string): Promise<LinkRecord | null> {
  const link = await findLink(env, uuid);
  return linkAllowed(link) ? link : null;
}

export function publicLinkData(link: LinkRecord, origin: string): Record<string, unknown> {
  return {
    uuid: link.uuid,
    label: link.label,
    active: linkAllowed(link),
    protocol: link.protocol,
    used_bytes: link.used_bytes,
    used_fmt: formatBytes(link.used_bytes),
    limit_bytes: link.limit_bytes,
    limit_fmt: link.limit_bytes === 0 ? "∞" : formatBytes(link.limit_bytes),
    expires_at: link.expires_at,
    vless_link: generateVlessLink(link, origin),
    sub_url: `${origin}/sub/${link.uuid}`,
    connections: 0,
    ip_limit: link.ip_limit,
    speed_limit_bytes: link.speed_limit_bytes,
  };
}

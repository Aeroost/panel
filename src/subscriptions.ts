import type { Env, SubscriptionRecord } from "./database";
import { asLink, asSubscription, first, logActivity, query, run } from "./database";
import { hashPassword, verifyPassword } from "./auth";
import { findLink, generateVlessLink, linkAllowed, publicLinkData } from "./links";
import {
  HttpError,
  formatBytes,
  json,
  getPublicOrigin,
  nowIso,
  randomToken,
  readJson,
} from "./utils";

export interface SubscriptionSummary extends SubscriptionRecord {
  password_hash: null;
  has_password: boolean;
  links_count: number;
  active_count: number;
  total_used_bytes: number;
  total_used_fmt: string;
  public_url: string;
  sub_url: string;
}

export async function findSubscription(env: Env, subId: string): Promise<SubscriptionRecord | null> {
  const row = await first<Record<string, unknown>>(env, "SELECT * FROM subscriptions WHERE sub_id = ?", subId);
  return row ? asSubscription(row) : null;
}

export async function findSubscriptionByKey(env: Env, uuidKey: string): Promise<SubscriptionRecord | null> {
  const row = await first<Record<string, unknown>>(env, "SELECT * FROM subscriptions WHERE uuid_key = ?", uuidKey);
  return row ? asSubscription(row) : null;
}

async function getGroupLinks(env: Env, subId: string) {
  return query<Record<string, unknown>>(env, "SELECT * FROM links WHERE sub_id = ? ORDER BY created_at DESC", subId);
}

export async function listSubscriptions(env: Env, request: Request): Promise<SubscriptionSummary[]> {
  const origin = getPublicOrigin(request, env);
  const rows = await query<Record<string, unknown>>(
    env,
    `SELECT s.sub_id, s.name, s.description, s.password_hash, s.uuid_key, s.created_at, s.updated_at,
            COUNT(l.uuid) AS links_count,
            COALESCE(SUM(l.used_bytes), 0) AS total_used_bytes,
            COALESCE(SUM(CASE WHEN l.active = 1
              AND (l.expires_at IS NULL OR l.expires_at > ?)
              AND (l.limit_bytes <= 0 OR l.used_bytes < l.limit_bytes)
              THEN 1 ELSE 0 END), 0) AS active_count
     FROM subscriptions s
     LEFT JOIN links l ON l.sub_id = s.sub_id
     GROUP BY s.sub_id, s.name, s.description, s.password_hash, s.uuid_key, s.created_at, s.updated_at
     ORDER BY s.created_at DESC`,
    nowIso(),
  );
  return rows.map((row) => {
    const sub = asSubscription(row);
    const totalUsed = Number(row.total_used_bytes || 0);
    return {
      ...sub,
      password_hash: null,
      has_password: Boolean(sub.password_hash),
      links_count: Number(row.links_count || 0),
      active_count: Number(row.active_count || 0),
      total_used_bytes: totalUsed,
      total_used_fmt: formatBytes(totalUsed),
      public_url: `${origin}/p/${sub.uuid_key}`,
      sub_url: `${origin}/sub-group/${sub.uuid_key}`,
    };
  });
}

export async function createSubscription(env: Env, request: Request): Promise<Record<string, unknown>> {
  const body = await readJson<{
    name?: string;
    desc?: string;
    description?: string;
    password?: string;
  }>(request);
  const name = String(body.name || "گروه جدید").trim().slice(0, 60) || "گروه جدید";
  const description = String(body.desc ?? body.description ?? "").trim().slice(0, 200);
  const password = String(body.password || "").trim();
  const subId = crypto.randomUUID();
  const uuidKey = randomToken(16);
  const timestamp = nowIso();
  const passwordHash = password ? await hashPassword(password) : null;
  await run(
    env,
    `INSERT INTO subscriptions (sub_id, name, description, password_hash, uuid_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    subId,
    name,
    description,
    passwordHash,
    uuidKey,
    timestamp,
    timestamp,
  );
  await logActivity(env, "sub", `subscription group created: ${name}`, "ok");
  const origin = getPublicOrigin(request, env);
  const sub = await findSubscription(env, subId);
  if (!sub) throw new HttpError(500, "subscription creation failed");
  return {
    sub_id: sub.sub_id,
    name: sub.name,
    desc: sub.description,
    uuid_key: sub.uuid_key,
    created_at: sub.created_at,
    link_ids: [],
    public_url: `${origin}/p/${sub.uuid_key}`,
    sub_url: `${origin}/sub-group/${sub.uuid_key}`,
  };
}

export async function updateSubscription(env: Env, request: Request, subId: string): Promise<Response> {
  const sub = await findSubscription(env, subId);
  if (!sub) throw new HttpError(404, "sub not found");
  const body = await readJson<Record<string, unknown>>(request);
  const name = body.name === undefined ? sub.name : String(body.name).trim().slice(0, 60) || "گروه جدید";
  const description = body.desc === undefined && body.description === undefined
    ? sub.description
    : String(body.desc ?? body.description ?? "").trim().slice(0, 200);
  const passwordHash = body.password === undefined
    ? sub.password_hash
    : (String(body.password || "").trim() ? await hashPassword(String(body.password).trim()) : null);
  await run(
    env,
    "UPDATE subscriptions SET name = ?, description = ?, password_hash = ?, updated_at = ? WHERE sub_id = ?",
    name,
    description,
    passwordHash,
    nowIso(),
    subId,
  );
  if (Array.isArray(body.link_ids)) {
    const linkIds = [...new Set(body.link_ids.map(String))];
    await env.DB.batch([
      env.DB.prepare("UPDATE links SET sub_id = NULL WHERE sub_id = ?").bind(subId),
      ...linkIds.map((uuid) => env.DB.prepare("UPDATE links SET sub_id = ? WHERE uuid = ?").bind(subId, uuid)),
    ]);
  }
  await logActivity(env, "sub", `subscription group updated: ${name}`, "info");
  return json({ ok: true });
}

export async function deleteSubscription(env: Env, subId: string): Promise<Response> {
  const sub = await findSubscription(env, subId);
  if (!sub) throw new HttpError(404, "sub not found");
  await run(env, "DELETE FROM subscriptions WHERE sub_id = ?", subId);
  await logActivity(env, "sub", `subscription group deleted: ${sub.name}`, "warn");
  return json({ ok: true, deleted: subId });
}

export async function assignLinkToSubscription(env: Env, request: Request, subId: string): Promise<Response> {
  const sub = await findSubscription(env, subId);
  if (!sub) throw new HttpError(404, "sub not found");
  const body = await readJson<{ link_id?: string; action?: string }>(request);
  const linkId = String(body.link_id || "");
  const link = await findLink(env, linkId);
  if (!link) throw new HttpError(404, "link not found");
  const targetSubId = body.action === "remove" ? null : subId;
  await run(env, "UPDATE links SET sub_id = ? WHERE uuid = ?", targetSubId, linkId);
  await logActivity(env, "link", `link assigned to subscription: ${link.label}`, "info", { sub_id: targetSubId });
  return json({ ok: true });
}

export async function renderSingleSubscription(env: Env, request: Request, uuid: string): Promise<Response> {
  const link = await findLink(env, uuid);
  if (!link || !linkAllowed(link)) throw new HttpError(404, "not found or inactive");
  const origin = getPublicOrigin(request, env);
  const value = btoa(generateVlessLink(link, origin));
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "profile-title": encodeURIComponent(link.label),
    "support-url": "",
    "cache-control": "no-store",
  });
  return new Response(value, { headers });
}

export async function renderGroupSubscription(env: Env, request: Request, uuidKey: string): Promise<Response> {
  const sub = await findSubscriptionByKey(env, uuidKey);
  if (!sub) throw new HttpError(404, "not found");
  if (sub.password_hash) {
    const password = new URL(request.url).searchParams.get("pw") || "";
    if (!(await verifyPassword(password, sub.password_hash, env.LEGACY_SECRET_KEY))) throw new HttpError(403, "wrong password");
  }
  const origin = getPublicOrigin(request, env);
  const rows = await getGroupLinks(env, sub.sub_id);
  const lines: string[] = [];
  for (const row of rows) {
    const link = asLink(row);
    if (linkAllowed(link)) lines.push(generateVlessLink(link, origin));
  }
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "profile-title": encodeURIComponent(sub.name),
    "support-url": "",
    "profile-update-interval": "12",
    "cache-control": "no-store",
  });
  return new Response(btoa(lines.join("\n")), { headers });
}

export async function getPublicSubscriptionData(
  env: Env,
  request: Request,
  uuidKey: string,
): Promise<Record<string, unknown>> {
  const sub = await findSubscriptionByKey(env, uuidKey);
  if (!sub) throw new HttpError(404, "not found");
  const password = new URL(request.url).searchParams.get("pw") || "";
  if (sub.password_hash && !(await verifyPassword(password, sub.password_hash, env.LEGACY_SECRET_KEY))) {
    return { locked: true, name: sub.name };
  }
  const origin = getPublicOrigin(request, env);
  const rows = await getGroupLinks(env, sub.sub_id);
  const links = rows.map((row) => publicLinkData(asLink(row), origin));
  const totalUsed = rows.reduce((sum, row) => sum + Number(row.used_bytes || 0), 0);
  return {
    locked: false,
    name: sub.name,
    desc: sub.description,
    sub_url: `${origin}/sub-group/${uuidKey}`,
    active_connections: 0,
    total_used_fmt: formatBytes(totalUsed),
    links,
  };
}

#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
const inputPath = process.argv[2] || "gateway_state.json";
const outputPath = process.argv[3] || "state-migration.sql";

if (!fs.existsSync(inputPath)) {
  console.error(`State file not found: ${inputPath}`);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const links = state.links && typeof state.links === "object" ? state.links : {};
const subscriptions = state.subs && typeof state.subs === "object" ? state.subs : {};
const timestamp = new Date().toISOString();

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bool(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

function nonNegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

const knownSubscriptionIds = new Set(Object.keys(subscriptions));
const membership = new Map();
for (const [subId, subscription] of Object.entries(subscriptions)) {
  for (const uuid of Array.isArray(subscription.link_ids) ? subscription.link_ids : []) {
    if (!membership.has(String(uuid))) membership.set(String(uuid), String(subId));
  }
}

const statements = ["PRAGMA foreign_keys = ON;"];

const adminHash = state.password_hash ? `legacy-sha256$${state.password_hash}` : null;
if (adminHash) {
  statements.push(
    `INSERT OR IGNORE INTO admins (username, password_hash, created_at, updated_at) VALUES ('admin', ${sql(adminHash)}, ${sql(timestamp)}, ${sql(timestamp)});`,
  );
}

for (const [subId, value] of Object.entries(subscriptions)) {
  const subscription = value || {};
  const name = String(subscription.name || "گروه جدید").slice(0, 60);
  const description = String(subscription.desc || "").slice(0, 200);
  const oldPasswordHash = subscription.password_hash
    ? `legacy-sha256$${subscription.password_hash}`
    : null;
  const uuidKey = String(subscription.uuid_key || randomUUID());
  const createdAt = String(subscription.created_at || timestamp);
  statements.push(
    `INSERT OR IGNORE INTO subscriptions (sub_id, name, description, password_hash, uuid_key, created_at, updated_at) VALUES (${sql(subId)}, ${sql(name)}, ${sql(description)}, ${sql(oldPasswordHash)}, ${sql(uuidKey)}, ${sql(createdAt)}, ${sql(timestamp)});`,
  );
}

for (const [uuid, value] of Object.entries(links)) {
  const link = value || {};
  const candidateSubId = link.sub_id || membership.get(String(uuid)) || null;
  const subId = candidateSubId && knownSubscriptionIds.has(String(candidateSubId)) ? String(candidateSubId) : null;
  const protocol = ["vless-ws", "xhttp-packet-up", "xhttp-stream-up", "xhttp-stream-one"].includes(String(link.protocol))
    ? String(link.protocol)
    : "vless-ws";
  statements.push(
    `INSERT OR IGNORE INTO links (uuid, label, limit_bytes, used_bytes, created_at, active, expires_at, note, is_default, sub_id, protocol, fingerprint, alpn, port, ip_limit, speed_limit_bytes) VALUES (` +
    [
      uuid,
      String(link.label || "لینک جدید").slice(0, 60),
      nonNegative(link.limit_bytes),
      nonNegative(link.used_bytes),
      String(link.created_at || timestamp),
      bool(link.active, true),
      link.expires_at || null,
      String(link.note || "").slice(0, 200),
      bool(link.is_default, false),
      subId,
      protocol,
      String(link.fingerprint || "chrome"),
      String(link.alpn || "").slice(0, 100),
      443,
      nonNegative(link.ip_limit),
      nonNegative(link.speed_limit_bytes),
    ].map(sql).join(", ") + ");",
  );
}

statements.push(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('legacy_state_imported_at', ${sql(timestamp)}, ${sql(timestamp)});`);
fs.writeFileSync(outputPath, `${statements.join("\n")}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
console.log(`Imported candidates: ${Object.keys(links).length} links, ${Object.keys(subscriptions).length} subscription groups`);
console.log("Before login, set LEGACY_SECRET_KEY to the old gateway_secret.key/SECRET_KEY so legacy hashes can be verified once and upgraded to PBKDF2.");

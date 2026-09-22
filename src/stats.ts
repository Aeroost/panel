import type { Env } from "./database";
import { countActiveConnections, first, query } from "./database";
import { formatBytes, isExpired, nowIso } from "./utils";

export async function getStats(env: Env): Promise<Record<string, unknown>> {
  const [links, subs, traffic, errors, errorCount, activeConnections] = await Promise.all([
    query<Record<string, unknown>>(env, "SELECT active, expires_at, used_bytes FROM links"),
    first<{ count: number }>(env, "SELECT COUNT(*) AS count FROM subscriptions"),
    query<Record<string, unknown>>(
      env,
      `SELECT bucket_hour, SUM(bytes_up + bytes_down) AS bytes
       FROM traffic GROUP BY bucket_hour ORDER BY bucket_hour ASC`,
    ),
    query<Record<string, unknown>>(
      env,
      "SELECT message AS error, created_at AS time, metadata_json FROM logs WHERE level = 'err' ORDER BY id DESC LIMIT 10",
    ),
    first<{ count: number }>(env, "SELECT COUNT(*) AS count FROM logs WHERE level = 'err'"),
    countActiveConnections(env),
  ]);
  const hourly: Record<string, number> = {};
  let totalBytes = 0;
  let totalRequests = 0;
  for (const row of traffic) {
    const bytes = Number(row.bytes || 0);
    hourly[String(row.bucket_hour)] = bytes;
    totalBytes += bytes;
  }
  const importedUsage = links.reduce((sum, link) => sum + Number(link.used_bytes || 0), 0);
  totalBytes = Math.max(totalBytes, importedUsage);
  const requests = await first<{ total: number }>(env, "SELECT COALESCE(SUM(requests), 0) AS total FROM traffic");
  totalRequests = Number(requests?.total || 0);
  const activeLinks = links.filter((link) => Boolean(link.active)
    && !isExpired(link.expires_at as string | null)
    && (Number(link.limit_bytes || 0) <= 0 || Number(link.used_bytes || 0) < Number(link.limit_bytes || 0))).length;
  const expiredLinks = links.filter((link) => isExpired(link.expires_at as string | null)).length;
  return {
    active_connections: activeConnections,
    total_traffic_mb: Number((totalBytes / 1024 ** 2).toFixed(2)),
    total_requests: totalRequests,
    total_errors: Number(errorCount?.count || 0),
    uptime: "serverless",
    timestamp: nowIso(),
    hourly,
    recent_errors: errors.map((row) => ({ error: row.error, time: row.time, url: row.metadata_json || undefined })),
    links_count: links.length,
    active_links: activeLinks,
    expired_links: expiredLinks,
    subs_count: Number(subs?.count || 0),
  };
}

export async function getActivity(env: Env): Promise<Record<string, unknown>> {
  const logs = await query<Record<string, unknown>>(
    env,
    `SELECT kind, level, message, created_at AS time, metadata_json
     FROM logs ORDER BY id DESC LIMIT 150`,
  );
  return { logs: logs.reverse() };
}

export async function getConnections(env: Env): Promise<Record<string, unknown>> {
  const rows = await query<Record<string, unknown>>(
    env,
    `SELECT c.session_id, c.link_uuid, c.ip, c.transport, c.connected_at,
            c.disconnected_at, c.bytes_up, c.bytes_down, l.label
     FROM connections c LEFT JOIN links l ON l.uuid = c.link_uuid
     WHERE c.status = 'active' ORDER BY c.connected_at DESC`,
  );
  const grouped = new Map<string, {
    ip: string;
    sessions: number;
    bytes: number;
    labels: Set<string>;
    transports: Set<string>;
    first_connected_at: string | null;
    last_connected_at: string | null;
  }>();
  for (const row of rows) {
    const ip = String(row.ip || "unknown");
    const existing = grouped.get(ip) || {
      ip,
      sessions: 0,
      bytes: 0,
      labels: new Set<string>(),
      transports: new Set<string>(),
      first_connected_at: null,
      last_connected_at: null,
    };
    existing.sessions += 1;
    existing.bytes += Number(row.bytes_up || 0) + Number(row.bytes_down || 0);
    if (row.label) existing.labels.add(String(row.label));
    existing.transports.add(String(row.transport || "unknown"));
    const connected = String(row.connected_at || "");
    if (!existing.first_connected_at || connected < existing.first_connected_at) existing.first_connected_at = connected;
    if (!existing.last_connected_at || connected > existing.last_connected_at) existing.last_connected_at = connected;
    grouped.set(ip, existing);
  }
  const connections = [...grouped.values()].map((item) => ({
    ip: item.ip,
    sessions: item.sessions,
    labels: [...item.labels].sort(),
    label: [...item.labels].sort().join(" · ") || "نامشخص",
    transports: [...item.transports].sort(),
    bytes: item.bytes,
    bytes_fmt: formatBytes(item.bytes),
    connected_at: item.first_connected_at,
    last_connected_at: item.last_connected_at,
  }));
  return { connections, count: connections.length, raw_count: rows.length };
}

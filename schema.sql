PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE DEFAULT 'admin',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  sub_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  uuid_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  uuid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  limit_bytes INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  expires_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sub_id TEXT,
  protocol TEXT NOT NULL DEFAULT 'vless-ws',
  fingerprint TEXT NOT NULL DEFAULT 'chrome',
  alpn TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 443 CHECK (port BETWEEN 1 AND 65535),
  ip_limit INTEGER NOT NULL DEFAULT 0,
  speed_limit_bytes INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (sub_id) REFERENCES subscriptions(sub_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_sub_id ON links(sub_id);
CREATE INDEX IF NOT EXISTS idx_links_active ON links(active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_single_default ON links(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS traffic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_uuid TEXT NOT NULL,
  bucket_hour TEXT NOT NULL,
  bytes_up INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (link_uuid) REFERENCES links(uuid) ON DELETE CASCADE,
  UNIQUE (link_uuid, bucket_hour)
);

CREATE INDEX IF NOT EXISTS idx_traffic_bucket_hour ON traffic(bucket_hour);
CREATE INDEX IF NOT EXISTS idx_traffic_link_uuid ON traffic(link_uuid);

CREATE TABLE IF NOT EXISTS connections (
  session_id TEXT PRIMARY KEY,
  link_uuid TEXT,
  ip TEXT NOT NULL,
  transport TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  disconnected_at TEXT,
  bytes_up INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'rejected')),
  FOREIGN KEY (link_uuid) REFERENCES links(uuid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);
CREATE INDEX IF NOT EXISTS idx_connections_link_uuid ON connections(link_uuid);
CREATE INDEX IF NOT EXISTS idx_connections_connected_at ON connections(connected_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('default_port', '443', datetime('now'));

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('site_name', 'Gateway', datetime('now'));

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('timezone', 'Asia/Tehran', datetime('now'));

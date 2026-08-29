export function ensureV2Schema(db) {
  db.exec("PRAGMA foreign_keys = ON;");
  const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  const migrations = [
    ["job_source", "ALTER TABLE jobs ADD COLUMN job_source TEXT NOT NULL DEFAULT 'maxun'"],
    ["region", "ALTER TABLE jobs ADD COLUMN region TEXT NOT NULL DEFAULT ''"],
    ["experience", "ALTER TABLE jobs ADD COLUMN experience TEXT NOT NULL DEFAULT 'unranked'"],
    ["relevance", "ALTER TABLE jobs ADD COLUMN relevance TEXT NOT NULL DEFAULT 'unranked'"],
  ];
  for (const [column, statement] of migrations) {
    if (!columns.has(column)) db.exec(statement);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS jobs_source_region_idx ON jobs(job_source, region, is_current);
    CREATE INDEX IF NOT EXISTS jobs_classification_idx
      ON jobs(notification_status, experience, relevance, region, recorded_at);
    CREATE TABLE IF NOT EXISTS job_content (
      robot_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_source TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      retrieved_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (robot_id, item_key),
      FOREIGN KEY (robot_id, item_key) REFERENCES jobs(robot_id, item_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS job_evaluations (
      robot_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      criteria_version TEXT NOT NULL,
      experience TEXT NOT NULL DEFAULT 'unranked',
      relevance TEXT NOT NULL DEFAULT 'unranked',
      experience_evidence TEXT NOT NULL DEFAULT '',
      relevance_evidence TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      evaluated_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (robot_id, item_key, criteria_version),
      FOREIGN KEY (robot_id, item_key) REFERENCES jobs(robot_id, item_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS job_deliveries (
      robot_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      route TEXT NOT NULL,
      delivered_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (robot_id, item_key, route),
      FOREIGN KEY (robot_id, item_key) REFERENCES jobs(robot_id, item_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS job_content_status_idx ON job_content(status, attempts);
    CREATE INDEX IF NOT EXISTS job_evaluations_status_idx ON job_evaluations(status, criteria_version, attempts);
    CREATE INDEX IF NOT EXISTS job_deliveries_status_idx ON job_deliveries(status, route, attempts);
  `);
}

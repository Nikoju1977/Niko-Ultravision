-- Persistent, user/workspace-scoped Studio projects. This is a new additive
-- migration rather than an edit to 0001 so already-created apps receive it.
CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS studio_projects_owner_updated_idx
  ON studio_projects (owner_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS studio_generation_projects (
  owner_key TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_key, generation_id),
  FOREIGN KEY (project_id) REFERENCES studio_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS studio_generation_projects_project_idx
  ON studio_generation_projects (owner_key, project_id);

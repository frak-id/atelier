CREATE TABLE slack_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sandbox_id TEXT,
  session_id TEXT,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  initial_message TEXT NOT NULL,
  branch_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_slack_threads_thread ON slack_threads(channel_id, thread_ts);
CREATE INDEX idx_slack_threads_workspace ON slack_threads(workspace_id);
CREATE INDEX idx_slack_threads_status ON slack_threads(status);

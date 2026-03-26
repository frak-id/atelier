ALTER TABLE users ADD COLUMN github_access_token TEXT;
--> statement-breakpoint
DROP TABLE IF EXISTS git_sources;

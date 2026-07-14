CREATE TABLE `sandbox_toolset_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sandbox_id` text NOT NULL,
	`ref` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_toolset_refs_sandbox` ON `sandbox_toolset_refs` (`sandbox_id`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_toolset_refs_ref` ON `sandbox_toolset_refs` (`ref`);
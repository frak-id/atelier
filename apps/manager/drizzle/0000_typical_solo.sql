CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`git_url` text NOT NULL,
	`default_branch` text NOT NULL,
	`base_image` text NOT NULL,
	`vcpus` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`init_commands` text NOT NULL,
	`start_commands` text NOT NULL,
	`secrets` text NOT NULL,
	`exposed_ports` text NOT NULL,
	`latest_prebuild_id` text,
	`prebuild_status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`project_id` text,
	`branch` text,
	`ip_address` text NOT NULL,
	`mac_address` text NOT NULL,
	`urls_vscode` text NOT NULL,
	`urls_opencode` text NOT NULL,
	`urls_ssh` text NOT NULL,
	`vcpus` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`pid` integer,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

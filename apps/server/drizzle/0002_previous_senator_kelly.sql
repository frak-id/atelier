CREATE TABLE `catalog` (
	`name` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL
);

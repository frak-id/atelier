CREATE TABLE `toolsets` (
	`hash` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ref` text NOT NULL,
	`paths` text NOT NULL,
	`env` text,
	`provenance` text NOT NULL,
	`private` integer NOT NULL,
	`created_at` text NOT NULL
);

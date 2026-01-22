CREATE TABLE `shared_auth` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text
);

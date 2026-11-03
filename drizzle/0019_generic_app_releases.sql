CREATE TABLE `apk_release_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	FOREIGN KEY (`release_id`) REFERENCES `apk_releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apk_release_tokens_token_unique` ON `apk_release_tokens` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `apk_release_tokens_pair` ON `apk_release_tokens` (`release_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `apk_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`version_code` integer NOT NULL,
	`version_name` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`apk_path` text,
	`sha256` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apk_releases_version_code_unique` ON `apk_releases` (`version_code`);--> statement-breakpoint
ALTER TABLE `apk_builds` DROP COLUMN `session_borrowed`;--> statement-breakpoint
ALTER TABLE `apk_builds` DROP COLUMN `sha256`;
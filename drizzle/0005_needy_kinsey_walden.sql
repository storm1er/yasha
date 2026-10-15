CREATE TABLE `job_checkpoints` (
	`job_type` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`through_message_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`job_type`, `thread_id`)
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'fact' NOT NULL,
	`text` text NOT NULL,
	`source` text DEFAULT 'derived' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`thread_id` text,
	`superseded_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memories_user_pinned_idx` ON `memories` (`user_id`,`pinned`);--> statement-breakpoint
CREATE INDEX `memories_user_updated_idx` ON `memories` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

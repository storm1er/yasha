CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`type` text NOT NULL,
	`thread_id` text,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_after` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`locked_at` integer,
	`heartbeat_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`last_error` text,
	`payload_json` text,
	`result_json` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_key_unique` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_thread_type_idx` ON `jobs` (`thread_id`,`type`);--> statement-breakpoint
CREATE INDEX `jobs_user_idx` ON `jobs` (`user_id`);
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'gemini' NOT NULL,
	`filename` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`status` text DEFAULT 'uploading' NOT NULL,
	`checkpoint_offset` integer DEFAULT 0 NOT NULL,
	`checkpoint_lines` integer DEFAULT 0 NOT NULL,
	`total_lines` integer DEFAULT 0 NOT NULL,
	`imported` integer DEFAULT 0 NOT NULL,
	`skipped_unchanged` integer DEFAULT 0 NOT NULL,
	`skipped_changed` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`malformed_count` integer DEFAULT 0 NOT NULL,
	`flagged_count` integer DEFAULT 0 NOT NULL,
	`options_json` text,
	`counts_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_batches_user_created_idx` ON `import_batches` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_imports` (
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`import_id` text NOT NULL,
	`provider` text DEFAULT 'gemini' NOT NULL,
	`external_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`line_index` integer NOT NULL,
	`flags_json` text,
	`imported_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_imports_unique_external` ON `thread_imports` (`user_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_imports_thread_idx` ON `thread_imports` (`thread_id`);--> statement-breakpoint
CREATE INDEX `thread_imports_import_line_idx` ON `thread_imports` (`import_id`,`line_index`);--> statement-breakpoint
CREATE INDEX `thread_imports_user_body_idx` ON `thread_imports` (`user_id`,`provider`,`body_hash`);
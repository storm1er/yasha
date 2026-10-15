CREATE TABLE `thread_summaries` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`summary` text NOT NULL,
	`through_message_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

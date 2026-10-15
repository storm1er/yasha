CREATE TABLE `user_settings_new` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`,`key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `user_settings_new`(`user_id`,`key`,`value`,`updated_at`) SELECT `user_id`,`key`,`value`,MIN(`updated_at`) FROM `user_settings` GROUP BY `user_id`,`key`;
--> statement-breakpoint
DROP TABLE `user_settings`;
--> statement-breakpoint
ALTER TABLE `user_settings_new` RENAME TO `user_settings`;

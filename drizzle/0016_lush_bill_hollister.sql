CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`display_name` text,
	`vision` integer,
	`audio_input` integer,
	`context_window` integer,
	`hidden` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_remote_idx` ON `models` (`provider_id`,`remote_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text,
	`enabled` integer DEFAULT true NOT NULL,
	`config_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

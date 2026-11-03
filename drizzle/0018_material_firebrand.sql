ALTER TABLE `apk_builds` ADD `session_borrowed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `apk_builds` ADD `sha256` text;
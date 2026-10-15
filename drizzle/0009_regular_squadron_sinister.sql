CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`headers_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled_tools_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE TABLE `mcp_oauth` (
	`server_id` text PRIMARY KEY NOT NULL,
	`issuer` text,
	`client_json` text,
	`tokens_json` text,
	`discovery_json` text,
	`pending_state` text,
	`pending_verifier` text,
	`pending_url` text,
	`pending_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);

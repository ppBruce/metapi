CREATE TABLE IF NOT EXISTS `site_model_context` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`model_name_raw` text,
	`context_limit` integer,
	`source` text DEFAULT 'error' NOT NULL,
	`observed_max_prompt` integer,
	`note` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_model_context_site_model_unique` ON `site_model_context` (`site_id`,`model_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_model_context_site_id_idx` ON `site_model_context` (`site_id`);

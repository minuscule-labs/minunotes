CREATE TABLE `note_creation_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`note_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`folder_id`,`user_id`) REFERENCES `folders`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "note_creation_requests_request_check" CHECK(length("note_creation_requests"."request_id") between 1 and 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_creation_requests_actor_destination_unique` ON `note_creation_requests` (`actor_user_id`,`actor_type`,`actor_id`,`folder_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `template_default_state` (
	`template_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`tags` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`template_id`,`user_id`) REFERENCES `notes`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "template_default_state_revision_check" CHECK("template_default_state"."revision" > 0),
	CONSTRAINT "template_default_state_tags_check" CHECK(json_valid("template_default_state"."tags") and json_type("template_default_state"."tags") = 'array' and length(cast("template_default_state"."tags" as blob)) <= 8192)
);
--> statement-breakpoint
ALTER TABLE `template_folder_assignments` ADD `defaults_revision` integer DEFAULT 0 NOT NULL CONSTRAINT `template_folder_assignments_revision_check` CHECK (`defaults_revision` >= 0);
--> statement-breakpoint
ALTER TABLE `template_folder_assignments` ADD `schema_id` text;
--> statement-breakpoint
ALTER TABLE `template_folder_assignments` ADD `property_defaults` text DEFAULT '{}' NOT NULL CONSTRAINT `template_folder_assignments_defaults_check` CHECK (json_valid(`property_defaults`) and json_type(`property_defaults`) = 'object' and length(cast(`property_defaults` as blob)) <= 262144);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_folder_assignments_destination_unique` ON `template_folder_assignments` (`user_id`,`template_id`,`folder_id`);
CREATE TABLE `folder_property_schemas` (
	`folder_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`schema_id` text NOT NULL,
	`revision` integer NOT NULL,
	`definitions` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`folder_id`,`user_id`) REFERENCES `folders`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "folder_property_schemas_revision_check" CHECK("folder_property_schemas"."revision" > 0),
	CONSTRAINT "folder_property_schemas_json_check" CHECK(json_valid("folder_property_schemas"."definitions") and json_type("folder_property_schemas"."definitions") = 'array' and length(cast("folder_property_schemas"."definitions" as blob)) <= 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folder_property_schemas_schema_id_unique` ON `folder_property_schemas` (`schema_id`);--> statement-breakpoint
CREATE TABLE `note_property_state` (
	`note_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`values` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`note_id`,`user_id`) REFERENCES `notes`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "note_property_state_revision_check" CHECK("note_property_state"."revision" > 0),
	CONSTRAINT "note_property_state_json_check" CHECK(json_valid("note_property_state"."values") and json_type("note_property_state"."values") = 'object' and length(cast("note_property_state"."values" as blob)) <= 262144)
);

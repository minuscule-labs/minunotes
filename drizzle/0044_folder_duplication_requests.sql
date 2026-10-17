CREATE TABLE `folder_duplication_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source_folder_id` text NOT NULL,
	`parent_folder_id` text,
	`title` text NOT NULL,
	`root_folder_id` text NOT NULL,
	`counts` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "folder_duplication_request_id_check" CHECK(length("folder_duplication_requests"."request_id") between 16 and 128),
	CONSTRAINT "folder_duplication_counts_check" CHECK(json_valid("folder_duplication_requests"."counts") and json_type("folder_duplication_requests"."counts") = 'object' and length(cast("folder_duplication_requests"."counts" as blob)) <= 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folder_duplication_actor_request_idx` ON `folder_duplication_requests` (`actor_user_id`,`request_id`);
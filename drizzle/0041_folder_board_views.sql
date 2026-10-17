CREATE TABLE `folder_board_views` (
	`folder_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`folder_id`,`user_id`) REFERENCES `folders`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "folder_board_views_version_check" CHECK("folder_board_views"."version" > 0),
	CONSTRAINT "folder_board_views_config_size_check" CHECK(length(cast("folder_board_views"."config" as blob)) <= 16384)
);

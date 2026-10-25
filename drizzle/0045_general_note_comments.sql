PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_note_comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`anchor_type` text NOT NULL,
	`anchor_from` integer,
	`anchor_to` integer,
	`quote` text,
	`prefix` text,
	`suffix` text,
	`document_hash` text,
	`detached` integer DEFAULT false NOT NULL,
	`created_by_actor_type` text NOT NULL,
	`created_by_actor_id` text,
	`resolved_by_actor_type` text,
	`resolved_by_actor_id` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`,`user_id`) REFERENCES `notes`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "note_comment_threads_target_check" CHECK(("__new_note_comment_threads"."anchor_type" = 'note' and "__new_note_comment_threads"."anchor_from" is null and "__new_note_comment_threads"."anchor_to" is null and "__new_note_comment_threads"."quote" is null and "__new_note_comment_threads"."prefix" is null and "__new_note_comment_threads"."suffix" is null and "__new_note_comment_threads"."document_hash" is null and "__new_note_comment_threads"."detached" = 0) or ("__new_note_comment_threads"."anchor_type" in ('range', 'line') and "__new_note_comment_threads"."anchor_from" is not null and "__new_note_comment_threads"."anchor_to" is not null and "__new_note_comment_threads"."quote" is not null and "__new_note_comment_threads"."document_hash" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_note_comment_threads`("id", "note_id", "user_id", "status", "anchor_type", "anchor_from", "anchor_to", "quote", "prefix", "suffix", "document_hash", "detached", "created_by_actor_type", "created_by_actor_id", "resolved_by_actor_type", "resolved_by_actor_id", "resolved_at", "created_at", "updated_at") SELECT "id", "note_id", "user_id", "status", "anchor_type", "anchor_from", "anchor_to", "quote", "prefix", "suffix", "document_hash", "detached", "created_by_actor_type", "created_by_actor_id", "resolved_by_actor_type", "resolved_by_actor_id", "resolved_at", "created_at", "updated_at" FROM `note_comment_threads`;--> statement-breakpoint
DROP TABLE `note_comment_threads`;--> statement-breakpoint
ALTER TABLE `__new_note_comment_threads` RENAME TO `note_comment_threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `note_comment_threads_user_note_updated_at_idx` ON `note_comment_threads` (`user_id`,`note_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `note_comment_threads_note_status_idx` ON `note_comment_threads` (`note_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `note_comment_threads_id_note_user_idx` ON `note_comment_threads` (`id`,`note_id`,`user_id`);
import { desc, relations, sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)]
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)]
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)]
);

export const emailProtectionVerdicts = sqliteTable(
  'email_protection_verdicts',
  {
    emailKey: text('email_key').primaryKey(),
    verdict: text('verdict', { enum: ['pass', 'fail'] }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('email_protection_verdicts_expires_at_idx').on(table.expiresAt)]
);

export const emailProtectionRateLimits = sqliteTable(
  'email_protection_rate_limits',
  {
    bucketKey: text('bucket_key').primaryKey(),
    requestCount: integer('request_count').notNull(),
    windowStartedAt: integer('window_started_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('email_protection_rate_limits_expires_at_idx').on(table.expiresAt)]
);

export const emailProtectionClientReputation = sqliteTable(
  'email_protection_client_reputation',
  {
    clientKey: text('client_key').primaryKey(),
    violationCount: integer('violation_count').notNull(),
    violationWindowStartedAt: integer('violation_window_started_at', { mode: 'timestamp_ms' }).notNull(),
    bannedUntil: integer('banned_until', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('email_protection_client_reputation_banned_until_idx').on(table.bannedUntil),
    index('email_protection_client_reputation_window_idx').on(table.violationWindowStartedAt),
  ]
);

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentFolderId: text('parent_folder_id'),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    isAgentReadOnly: integer('is_agent_read_only', { mode: 'boolean' }).notNull().default(false),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    trashBatchId: text('trash_batch_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('folders_user_id_idx').on(table.userId),
    uniqueIndex('folders_id_user_id_idx').on(table.id, table.userId),
    index('folders_parent_folder_id_idx').on(table.parentFolderId),
    index('folders_active_children_idx')
      .on(table.userId, table.parentFolderId, table.title, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('folders_created_by_user_id_idx').on(table.createdByUserId),
    index('folders_user_deleted_at_idx').on(table.userId, table.deletedAt),
    index('folders_trash_batch_id_idx').on(table.trashBatchId),
    foreignKey({
      columns: [table.parentFolderId, table.userId],
      foreignColumns: [table.id, table.userId],
      name: 'folders_parent_owner_fk',
    }).onDelete('cascade'),
    check(
      'folders_not_self_parent_check',
      sql`${table.parentFolderId} is null or ${table.parentFolderId} <> ${table.id}`
    ),
  ]
);

export const integrationAuthorizations = sqliteTable(
  'integration_authorizations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessMode: text('access_mode', { enum: ['all', 'top_level', 'specific'] })
      .notNull()
      .default('all'),
    canRead: integer('can_read', { mode: 'boolean' }).notNull().default(true),
    canCreate: integer('can_create', { mode: 'boolean' }).notNull().default(false),
    canEdit: integer('can_edit', { mode: 'boolean' }).notNull().default(false),
    canComment: integer('can_comment', { mode: 'boolean' }).notNull().default(false),
    canCreateFolders: integer('can_create_folders', { mode: 'boolean' }).notNull().default(false),
    sharedAccessMode: text('shared_access_mode', { enum: ['none', 'specific', 'all'] })
      .notNull()
      .default('none'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('integration_authorizations_user_id_idx').on(table.userId),
    uniqueIndex('integration_authorizations_id_user_id_idx').on(table.id, table.userId),
    check('integration_authorizations_access_mode_check', sql`${table.accessMode} in ('all', 'top_level', 'specific')`),
    check('integration_authorizations_can_read_check', sql`${table.canRead} in (0, 1)`),
    check('integration_authorizations_can_create_check', sql`${table.canCreate} in (0, 1)`),
    check('integration_authorizations_can_edit_check', sql`${table.canEdit} in (0, 1)`),
    check('integration_authorizations_can_comment_check', sql`${table.canComment} in (0, 1)`),
    check('integration_authorizations_can_create_folders_check', sql`${table.canCreateFolders} in (0, 1)`),
    check(
      'integration_authorizations_shared_access_mode_check',
      sql`${table.sharedAccessMode} in ('none', 'specific', 'all')`
    ),
    check(
      'integration_authorizations_comment_requires_read_check',
      sql`${table.canComment} = 0 or ${table.canRead} = 1`
    ),
  ]
);

export const authorizationFolderRules = sqliteTable(
  'authorization_folder_rules',
  {
    id: text('id').primaryKey(),
    authorizationId: text('authorization_id').notNull(),
    userId: text('user_id').notNull(),
    folderId: text('folder_id').notNull(),
    appliesTo: text('applies_to', { enum: ['exact', 'subtree'] })
      .notNull()
      .default('exact'),
    canRead: integer('can_read', { mode: 'boolean' }).notNull().default(false),
    canCreate: integer('can_create', { mode: 'boolean' }).notNull().default(false),
    canEdit: integer('can_edit', { mode: 'boolean' }).notNull().default(false),
    canComment: integer('can_comment', { mode: 'boolean' }).notNull().default(false),
    canCreateFolders: integer('can_create_folders', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('authorization_folder_rules_authorization_folder_idx').on(table.authorizationId, table.folderId),
    index('authorization_folder_rules_authorization_id_idx').on(table.authorizationId),
    index('authorization_folder_rules_folder_id_idx').on(table.folderId),
    index('authorization_folder_rules_user_id_idx').on(table.userId),
    foreignKey({
      columns: [table.authorizationId, table.userId],
      foreignColumns: [integrationAuthorizations.id, integrationAuthorizations.userId],
      name: 'authorization_folder_rules_authorization_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.folderId, table.userId],
      foreignColumns: [folders.id, folders.userId],
      name: 'authorization_folder_rules_folder_owner_fk',
    }).onDelete('cascade'),
    check('authorization_folder_rules_applies_to_check', sql`${table.appliesTo} in ('exact', 'subtree')`),
    check('authorization_folder_rules_can_read_check', sql`${table.canRead} in (0, 1)`),
    check('authorization_folder_rules_can_create_check', sql`${table.canCreate} in (0, 1)`),
    check('authorization_folder_rules_can_edit_check', sql`${table.canEdit} in (0, 1)`),
    check('authorization_folder_rules_can_comment_check', sql`${table.canComment} in (0, 1)`),
    check('authorization_folder_rules_can_create_folders_check', sql`${table.canCreateFolders} in (0, 1)`),
    check(
      'authorization_folder_rules_comment_requires_read_check',
      sql`${table.canComment} = 0 or ${table.canRead} = 1`
    ),
  ]
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    authorizationId: text('authorization_id').notNull().unique(),
    name: text('name').notNull(),
    uid: text('uid').notNull().unique(),
    hash: text('hash').notNull(),
    salt: text('salt').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('api_keys_user_id_idx').on(table.userId),
    foreignKey({
      columns: [table.authorizationId, table.userId],
      foreignColumns: [integrationAuthorizations.id, integrationAuthorizations.userId],
      name: 'api_keys_authorization_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    redirectUris: text('redirect_uris').notNull(),
    clientType: text('client_type', { enum: ['public', 'confidential'] })
      .notNull()
      .default('public'),
    clientSecretHash: text('client_secret_hash'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [index('oauth_clients_user_id_idx').on(table.userId)]
);

export const oauthAuthorizations = sqliteTable(
  'oauth_authorizations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    integrationAuthorizationId: text('integration_authorization_id').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default(''),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('oauth_authorizations_user_id_idx').on(table.userId),
    index('oauth_authorizations_client_id_idx').on(table.clientId),
    foreignKey({
      columns: [table.integrationAuthorizationId, table.userId],
      foreignColumns: [integrationAuthorizations.id, integrationAuthorizations.userId],
      name: 'oauth_authorizations_integration_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const oauthAuthorizationCodes = sqliteTable(
  'oauth_authorization_codes',
  {
    id: text('id').primaryKey(),
    codeHash: text('code_hash').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull().default(''),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),
    authorizationId: text('authorization_id')
      .notNull()
      .references(() => oauthAuthorizations.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('oauth_authorization_codes_code_hash_idx').on(table.codeHash),
    index('oauth_authorization_codes_authorization_id_idx').on(table.authorizationId),
  ]
);

export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    authorizationId: text('authorization_id')
      .notNull()
      .references(() => oauthAuthorizations.id, { onDelete: 'cascade' }),
    accessTokenHash: text('access_token_hash').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    scope: text('scope').notNull().default(''),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }).notNull(),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('oauth_tokens_access_token_hash_idx').on(table.accessTokenHash),
    uniqueIndex('oauth_tokens_refresh_token_hash_idx').on(table.refreshTokenHash),
    index('oauth_tokens_authorization_id_idx').on(table.authorizationId),
  ]
);

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('Untitled note'),
    content: text('content').notNull().default(''),
    documentType: text('document_type', { enum: ['markdown', 'canvas.default', 'canvas.mindmap'] })
      .notNull()
      .default('markdown'),
    type: text('type', { enum: ['note', 'template'] })
      .notNull()
      .default('note'),
    isApiEditable: integer('is_api_editable', { mode: 'boolean' }).notNull().default(true),
    updatedByActorType: text('updated_by_actor_type'),
    updatedByActorId: text('updated_by_actor_id'),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    trashBatchId: text('trash_batch_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('notes_user_id_idx').on(table.userId),
    uniqueIndex('notes_id_user_id_idx').on(table.id, table.userId),
    index('notes_folder_id_idx').on(table.folderId),
    index('notes_created_by_user_id_idx').on(table.createdByUserId),
    index('notes_type_idx').on(table.type),
    index('notes_document_type_idx').on(table.documentType),
    index('notes_user_deleted_at_idx').on(table.userId, table.deletedAt),
    index('notes_user_active_updated_title_id_idx').on(
      table.userId,
      table.deletedAt,
      desc(table.updatedAt),
      table.title,
      table.id
    ),
    index('notes_trash_batch_id_idx').on(table.trashBatchId),
    foreignKey({
      columns: [table.folderId, table.userId],
      foreignColumns: [folders.id, folders.userId],
      name: 'notes_folder_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteSearchDocuments = sqliteTable(
  'note_search_documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('note_search_documents_note_id_idx').on(table.noteId)]
);

export const collaborationGrants = sqliteTable(
  'collaboration_grants',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    granteeUserId: text('grantee_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    noteId: text('note_id'),
    folderId: text('folder_id'),
    role: text('role', { enum: ['viewer', 'commenter', 'editor'] }).notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('collaboration_grants_note_grantee_idx').on(table.noteId, table.granteeUserId),
    uniqueIndex('collaboration_grants_folder_grantee_idx').on(table.folderId, table.granteeUserId),
    uniqueIndex('collaboration_grants_id_grantee_idx').on(table.id, table.granteeUserId),
    index('collaboration_grants_owner_idx').on(table.ownerUserId),
    index('collaboration_grants_grantee_idx').on(table.granteeUserId),
    index('collaboration_grants_note_idx').on(table.noteId),
    index('collaboration_grants_folder_idx').on(table.folderId),
    foreignKey({
      columns: [table.noteId, table.ownerUserId],
      foreignColumns: [notes.id, notes.userId],
      name: 'collaboration_grants_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.folderId, table.ownerUserId],
      foreignColumns: [folders.id, folders.userId],
      name: 'collaboration_grants_folder_owner_fk',
    }).onDelete('cascade'),
    check(
      'collaboration_grants_one_resource_check',
      sql`(${table.noteId} is not null and ${table.folderId} is null) or (${table.noteId} is null and ${table.folderId} is not null)`
    ),
    check('collaboration_grants_role_check', sql`${table.role} in ('viewer', 'commenter', 'editor')`),
    check('collaboration_grants_not_self_check', sql`${table.ownerUserId} <> ${table.granteeUserId}`),
    check('collaboration_grants_creator_owner_check', sql`${table.createdByUserId} = ${table.ownerUserId}`),
  ]
);

export const collaborationInvitations = sqliteTable(
  'collaboration_invitations',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    invitedEmailKey: text('invited_email_key').notNull(),
    noteId: text('note_id'),
    folderId: text('folder_id'),
    role: text('role', { enum: ['viewer', 'commenter', 'editor'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    acceptedByUserId: text('accepted_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('collaboration_invitations_note_email_idx').on(table.noteId, table.invitedEmailKey),
    uniqueIndex('collaboration_invitations_folder_email_idx').on(table.folderId, table.invitedEmailKey),
    index('collaboration_invitations_owner_idx').on(table.ownerUserId),
    index('collaboration_invitations_email_idx').on(table.invitedEmailKey),
    index('collaboration_invitations_note_idx').on(table.noteId),
    index('collaboration_invitations_folder_idx').on(table.folderId),
    index('collaboration_invitations_expires_at_idx').on(table.expiresAt),
    foreignKey({
      columns: [table.noteId, table.ownerUserId],
      foreignColumns: [notes.id, notes.userId],
      name: 'collaboration_invitations_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.folderId, table.ownerUserId],
      foreignColumns: [folders.id, folders.userId],
      name: 'collaboration_invitations_folder_owner_fk',
    }).onDelete('cascade'),
    check(
      'collaboration_invitations_one_resource_check',
      sql`(${table.noteId} is not null and ${table.folderId} is null) or (${table.noteId} is null and ${table.folderId} is not null)`
    ),
    check('collaboration_invitations_role_check', sql`${table.role} in ('viewer', 'commenter', 'editor')`),
    check('collaboration_invitations_inviter_owner_check', sql`${table.invitedByUserId} = ${table.ownerUserId}`),
  ]
);

export const authorizationCollaborationScopes = sqliteTable(
  'authorization_collaboration_scopes',
  {
    id: text('id').primaryKey(),
    authorizationId: text('authorization_id').notNull(),
    userId: text('user_id').notNull(),
    collaborationGrantId: text('collaboration_grant_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('authorization_collaboration_scopes_authorization_grant_idx').on(
      table.authorizationId,
      table.collaborationGrantId
    ),
    index('authorization_collaboration_scopes_authorization_idx').on(table.authorizationId),
    index('authorization_collaboration_scopes_grant_idx').on(table.collaborationGrantId),
    index('authorization_collaboration_scopes_user_idx').on(table.userId),
    foreignKey({
      columns: [table.authorizationId, table.userId],
      foreignColumns: [integrationAuthorizations.id, integrationAuthorizations.userId],
      name: 'authorization_collaboration_scopes_authorization_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.collaborationGrantId, table.userId],
      foreignColumns: [collaborationGrants.id, collaborationGrants.granteeUserId],
      name: 'authorization_collaboration_scopes_grantee_fk',
    }).onDelete('cascade'),
  ]
);

export const templateFolderAssignments = sqliteTable(
  'template_folder_assignments',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('template_folder_assignments_template_id_idx').on(table.templateId),
    index('template_folder_assignments_folder_id_idx').on(table.folderId),
    index('template_folder_assignments_user_id_idx').on(table.userId),
    foreignKey({
      columns: [table.templateId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'template_folder_assignments_template_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.folderId, table.userId],
      foreignColumns: [folders.id, folders.userId],
      name: 'template_folder_assignments_folder_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteEvents = sqliteTable(
  'note_events',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    eventType: text('event_type').notNull(),
    summary: text('summary').notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('note_events_note_id_idx').on(table.noteId),
    index('note_events_user_id_idx').on(table.userId),
    index('note_events_created_at_idx').on(table.createdAt),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_events_note_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteVersions = sqliteTable(
  'note_versions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    documentType: text('document_type', { enum: ['markdown', 'canvas.default', 'canvas.mindmap'] })
      .notNull()
      .default('markdown'),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    createdAtValue: integer('created_at_value', { mode: 'timestamp' }).notNull(),
    isApiEditable: integer('is_api_editable', { mode: 'boolean' }).notNull().default(true),
    stateHash: text('state_hash').notNull(),
    reason: text('reason', {
      enum: ['create', 'autosave_checkpoint', 'before_agent_edit', 'before_restore', 'manual'],
    }).notNull(),
    actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    actorId: text('actor_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('note_versions_user_note_created_at_idx').on(table.userId, table.noteId, table.createdAt),
    index('note_versions_note_created_at_idx').on(table.noteId, table.createdAt),
    index('note_versions_note_state_hash_idx').on(table.noteId, table.stateHash),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_versions_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.folderId, table.userId],
      foreignColumns: [folders.id, folders.userId],
      name: 'note_versions_folder_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteCommentThreads = sqliteTable(
  'note_comment_threads',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    anchorType: text('anchor_type', { enum: ['range', 'line'] }).notNull(),
    anchorFrom: integer('anchor_from').notNull(),
    anchorTo: integer('anchor_to').notNull(),
    quote: text('quote').notNull(),
    prefix: text('prefix'),
    suffix: text('suffix'),
    documentHash: text('document_hash').notNull(),
    detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
    createdByActorType: text('created_by_actor_type', { enum: ['user', 'agent'] }).notNull(),
    createdByActorId: text('created_by_actor_id'),
    resolvedByActorType: text('resolved_by_actor_type', { enum: ['user', 'agent'] }),
    resolvedByActorId: text('resolved_by_actor_id'),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('note_comment_threads_user_note_updated_at_idx').on(table.userId, table.noteId, table.updatedAt),
    index('note_comment_threads_note_status_idx').on(table.noteId, table.status),
    uniqueIndex('note_comment_threads_id_note_user_idx').on(table.id, table.noteId, table.userId),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_comment_threads_note_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteCommentMessages = sqliteTable(
  'note_comment_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => noteCommentThreads.id, { onDelete: 'cascade' }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
    actorId: text('actor_id'),
    body: text('body').notNull(),
    isRoot: integer('is_root', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('note_comment_messages_thread_created_at_idx').on(table.threadId, table.createdAt),
    index('note_comment_messages_user_note_idx').on(table.userId, table.noteId),
    uniqueIndex('note_comment_messages_id_thread_note_user_idx').on(
      table.id,
      table.threadId,
      table.noteId,
      table.userId
    ),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_comment_messages_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId, table.noteId, table.userId],
      foreignColumns: [noteCommentThreads.id, noteCommentThreads.noteId, noteCommentThreads.userId],
      name: 'note_comment_messages_thread_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteCommentMessageReactions = sqliteTable(
  'note_comment_message_reactions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => noteCommentMessages.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => noteCommentThreads.id, { onDelete: 'cascade' }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
    actorId: text('actor_id'),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('note_comment_reactions_message_actor_emoji_idx').on(
      table.messageId,
      table.actorType,
      table.actorId,
      table.emoji
    ),
    index('note_comment_reactions_thread_idx').on(table.threadId),
    index('note_comment_reactions_user_note_idx').on(table.userId, table.noteId),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_comment_reactions_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId, table.noteId, table.userId],
      foreignColumns: [noteCommentThreads.id, noteCommentThreads.noteId, noteCommentThreads.userId],
      name: 'note_comment_reactions_thread_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.messageId, table.threadId, table.noteId, table.userId],
      foreignColumns: [
        noteCommentMessages.id,
        noteCommentMessages.threadId,
        noteCommentMessages.noteId,
        noteCommentMessages.userId,
      ],
      name: 'note_comment_reactions_message_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteShareLinks = sqliteTable(
  'note_share_links',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    token: text('token'),
    permission: text('permission', { enum: ['read'] })
      .notNull()
      .default('read'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('note_share_links_token_hash_idx').on(table.tokenHash),
    index('note_share_links_note_id_idx').on(table.noteId),
    index('note_share_links_user_id_idx').on(table.userId),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_share_links_note_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const folderShareLinks = sqliteTable(
  'folder_share_links',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    token: text('token'),
    permission: text('permission', { enum: ['read'] })
      .notNull()
      .default('read'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('folder_share_links_token_hash_idx').on(table.tokenHash),
    index('folder_share_links_folder_id_idx').on(table.folderId),
    index('folder_share_links_user_id_idx').on(table.userId),
    foreignKey({
      columns: [table.folderId, table.userId],
      foreignColumns: [folders.id, folders.userId],
      name: 'folder_share_links_folder_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('tags_user_id_idx').on(table.userId),
    uniqueIndex('tags_user_normalized_name_idx').on(table.userId, table.normalizedName),
    uniqueIndex('tags_id_user_id_idx').on(table.id, table.userId),
  ]
);

export const noteTags = sqliteTable(
  'note_tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('note_tags_user_id_idx').on(table.userId),
    index('note_tags_note_id_idx').on(table.noteId),
    index('note_tags_tag_id_idx').on(table.tagId),
    uniqueIndex('note_tags_note_tag_idx').on(table.noteId, table.tagId),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_tags_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tagId, table.userId],
      foreignColumns: [tags.id, tags.userId],
      name: 'note_tags_tag_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const noteLinks = sqliteTable(
  'note_links',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceNoteId: text('source_note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    targetNoteId: text('target_note_id').references(() => notes.id, { onDelete: 'set null' }),
    targetTitle: text('target_title').notNull(),
    label: text('label'),
    linkType: text('link_type', { enum: ['wikilink', 'internal-url', 'markdown-internal-url', 'canvas-note'] })
      .notNull()
      .default('wikilink'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('note_links_user_id_idx').on(table.userId),
    index('note_links_source_note_id_idx').on(table.sourceNoteId),
    index('note_links_target_note_id_idx').on(table.targetNoteId),
    index('note_links_user_target_title_idx').on(table.userId, table.targetTitle),
    foreignKey({
      columns: [table.sourceNoteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_links_source_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.targetNoteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'note_links_target_owner_fk',
    }),
  ]
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('filesystem'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    contentHash: text('content_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('ready'),
    referencedAt: integer('referenced_at', { mode: 'timestamp' }),
    unreferencedAt: integer('unreferenced_at', { mode: 'timestamp' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('attachments_user_id_idx').on(table.userId),
    index('attachments_note_id_idx').on(table.noteId),
    index('attachments_folder_id_idx').on(table.folderId),
    foreignKey({
      columns: [table.noteId, table.userId],
      foreignColumns: [notes.id, notes.userId],
      name: 'attachments_note_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.folderId, table.userId],
      foreignColumns: [folders.id, folders.userId],
      name: 'attachments_folder_owner_fk',
    }).onDelete('cascade'),
  ]
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  folders: many(folders),
  notes: many(notes),
  noteEvents: many(noteEvents),
  noteVersions: many(noteVersions),
  noteCommentThreads: many(noteCommentThreads),
  noteCommentMessages: many(noteCommentMessages),
  noteCommentMessageReactions: many(noteCommentMessageReactions),
  noteShareLinks: many(noteShareLinks),
  folderShareLinks: many(folderShareLinks),
  noteLinks: many(noteLinks),
  tags: many(tags),
  noteTags: many(noteTags),
  attachments: many(attachments),
  templateFolderAssignments: many(templateFolderAssignments),
  apiKeys: many(apiKeys),
  oauthAuthorizations: many(oauthAuthorizations),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const folderRelations = relations(folders, ({ many, one }) => ({
  user: one(user, { fields: [folders.userId], references: [user.id] }),
  notes: many(notes),
  attachments: many(attachments),
  templateAssignments: many(templateFolderAssignments),
  shareLinks: many(folderShareLinks),
  collaborationGrants: many(collaborationGrants),
  collaborationInvitations: many(collaborationInvitations),
}));

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  user: one(user, { fields: [apiKeys.userId], references: [user.id] }),
  authorization: one(integrationAuthorizations, {
    fields: [apiKeys.authorizationId],
    references: [integrationAuthorizations.id],
  }),
}));

export const oauthClientRelations = relations(oauthClients, ({ many, one }) => ({
  user: one(user, { fields: [oauthClients.userId], references: [user.id] }),
  authorizations: many(oauthAuthorizations),
  codes: many(oauthAuthorizationCodes),
}));

export const oauthAuthorizationRelations = relations(oauthAuthorizations, ({ many, one }) => ({
  user: one(user, { fields: [oauthAuthorizations.userId], references: [user.id] }),
  client: one(oauthClients, { fields: [oauthAuthorizations.clientId], references: [oauthClients.id] }),
  integrationAuthorization: one(integrationAuthorizations, {
    fields: [oauthAuthorizations.integrationAuthorizationId],
    references: [integrationAuthorizations.id],
  }),
  codes: many(oauthAuthorizationCodes),
  tokens: many(oauthTokens),
}));

export const oauthAuthorizationCodeRelations = relations(oauthAuthorizationCodes, ({ one }) => ({
  client: one(oauthClients, { fields: [oauthAuthorizationCodes.clientId], references: [oauthClients.id] }),
  user: one(user, { fields: [oauthAuthorizationCodes.userId], references: [user.id] }),
  authorization: one(oauthAuthorizations, {
    fields: [oauthAuthorizationCodes.authorizationId],
    references: [oauthAuthorizations.id],
  }),
}));

export const oauthTokenRelations = relations(oauthTokens, ({ one }) => ({
  authorization: one(oauthAuthorizations, {
    fields: [oauthTokens.authorizationId],
    references: [oauthAuthorizations.id],
  }),
}));

export const noteRelations = relations(notes, ({ many, one }) => ({
  user: one(user, { fields: [notes.userId], references: [user.id] }),
  folder: one(folders, { fields: [notes.folderId], references: [folders.id] }),
  events: many(noteEvents),
  versions: many(noteVersions),
  commentThreads: many(noteCommentThreads),
  commentMessages: many(noteCommentMessages),
  commentMessageReactions: many(noteCommentMessageReactions),
  shareLinks: many(noteShareLinks),
  tags: many(noteTags),
  outgoingLinks: many(noteLinks, { relationName: 'sourceNoteLinks' }),
  incomingLinks: many(noteLinks, { relationName: 'targetNoteLinks' }),
  attachments: many(attachments),
  templateAssignments: many(templateFolderAssignments),
  collaborationGrants: many(collaborationGrants),
  collaborationInvitations: many(collaborationInvitations),
}));

export const collaborationGrantRelations = relations(collaborationGrants, ({ many, one }) => ({
  owner: one(user, {
    fields: [collaborationGrants.ownerUserId],
    references: [user.id],
    relationName: 'ownedCollaborationGrants',
  }),
  grantee: one(user, {
    fields: [collaborationGrants.granteeUserId],
    references: [user.id],
    relationName: 'receivedCollaborationGrants',
  }),
  note: one(notes, { fields: [collaborationGrants.noteId], references: [notes.id] }),
  folder: one(folders, { fields: [collaborationGrants.folderId], references: [folders.id] }),
  authorizationScopes: many(authorizationCollaborationScopes),
}));

export const collaborationInvitationRelations = relations(collaborationInvitations, ({ one }) => ({
  owner: one(user, {
    fields: [collaborationInvitations.ownerUserId],
    references: [user.id],
    relationName: 'ownedCollaborationInvitations',
  }),
  acceptedBy: one(user, {
    fields: [collaborationInvitations.acceptedByUserId],
    references: [user.id],
    relationName: 'acceptedCollaborationInvitations',
  }),
  note: one(notes, { fields: [collaborationInvitations.noteId], references: [notes.id] }),
  folder: one(folders, { fields: [collaborationInvitations.folderId], references: [folders.id] }),
}));

export const authorizationCollaborationScopeRelations = relations(authorizationCollaborationScopes, ({ one }) => ({
  authorization: one(integrationAuthorizations, {
    fields: [authorizationCollaborationScopes.authorizationId],
    references: [integrationAuthorizations.id],
  }),
  collaborationGrant: one(collaborationGrants, {
    fields: [authorizationCollaborationScopes.collaborationGrantId],
    references: [collaborationGrants.id],
  }),
}));

export const templateFolderAssignmentRelations = relations(templateFolderAssignments, ({ one }) => ({
  template: one(notes, { fields: [templateFolderAssignments.templateId], references: [notes.id] }),
  folder: one(folders, { fields: [templateFolderAssignments.folderId], references: [folders.id] }),
  user: one(user, { fields: [templateFolderAssignments.userId], references: [user.id] }),
}));

export const noteEventRelations = relations(noteEvents, ({ one }) => ({
  note: one(notes, { fields: [noteEvents.noteId], references: [notes.id] }),
  user: one(user, { fields: [noteEvents.userId], references: [user.id] }),
}));

export const noteVersionRelations = relations(noteVersions, ({ one }) => ({
  note: one(notes, { fields: [noteVersions.noteId], references: [notes.id] }),
  user: one(user, { fields: [noteVersions.userId], references: [user.id] }),
  folder: one(folders, { fields: [noteVersions.folderId], references: [folders.id] }),
}));

export const noteCommentThreadRelations = relations(noteCommentThreads, ({ many, one }) => ({
  note: one(notes, { fields: [noteCommentThreads.noteId], references: [notes.id] }),
  user: one(user, { fields: [noteCommentThreads.userId], references: [user.id] }),
  messages: many(noteCommentMessages),
}));

export const noteCommentMessageRelations = relations(noteCommentMessages, ({ many, one }) => ({
  thread: one(noteCommentThreads, {
    fields: [noteCommentMessages.threadId],
    references: [noteCommentThreads.id],
  }),
  note: one(notes, { fields: [noteCommentMessages.noteId], references: [notes.id] }),
  user: one(user, { fields: [noteCommentMessages.userId], references: [user.id] }),
  reactions: many(noteCommentMessageReactions),
}));

export const noteCommentMessageReactionRelations = relations(noteCommentMessageReactions, ({ one }) => ({
  message: one(noteCommentMessages, {
    fields: [noteCommentMessageReactions.messageId],
    references: [noteCommentMessages.id],
  }),
  thread: one(noteCommentThreads, {
    fields: [noteCommentMessageReactions.threadId],
    references: [noteCommentThreads.id],
  }),
  note: one(notes, { fields: [noteCommentMessageReactions.noteId], references: [notes.id] }),
  user: one(user, { fields: [noteCommentMessageReactions.userId], references: [user.id] }),
}));

export const noteShareLinkRelations = relations(noteShareLinks, ({ one }) => ({
  note: one(notes, { fields: [noteShareLinks.noteId], references: [notes.id] }),
  user: one(user, { fields: [noteShareLinks.userId], references: [user.id] }),
}));

export const folderShareLinkRelations = relations(folderShareLinks, ({ one }) => ({
  folder: one(folders, { fields: [folderShareLinks.folderId], references: [folders.id] }),
  user: one(user, { fields: [folderShareLinks.userId], references: [user.id] }),
}));

export const tagRelations = relations(tags, ({ many, one }) => ({
  user: one(user, { fields: [tags.userId], references: [user.id] }),
  notes: many(noteTags),
}));

export const noteTagRelations = relations(noteTags, ({ one }) => ({
  user: one(user, { fields: [noteTags.userId], references: [user.id] }),
  note: one(notes, { fields: [noteTags.noteId], references: [notes.id] }),
  tag: one(tags, { fields: [noteTags.tagId], references: [tags.id] }),
}));

export const noteLinkRelations = relations(noteLinks, ({ one }) => ({
  user: one(user, { fields: [noteLinks.userId], references: [user.id] }),
  sourceNote: one(notes, { fields: [noteLinks.sourceNoteId], references: [notes.id], relationName: 'sourceNoteLinks' }),
  targetNote: one(notes, { fields: [noteLinks.targetNoteId], references: [notes.id], relationName: 'targetNoteLinks' }),
}));

export const attachmentRelations = relations(attachments, ({ one }) => ({
  user: one(user, { fields: [attachments.userId], references: [user.id] }),
  note: one(notes, { fields: [attachments.noteId], references: [notes.id] }),
  folder: one(folders, { fields: [attachments.folderId], references: [folders.id] }),
}));

export type Folder = typeof folders.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type CollaborationGrant = typeof collaborationGrants.$inferSelect;
export type CollaborationInvitation = typeof collaborationInvitations.$inferSelect;
export type AuthorizationCollaborationScope = typeof authorizationCollaborationScopes.$inferSelect;
export type TemplateFolderAssignment = typeof templateFolderAssignments.$inferSelect;
export type NoteEvent = typeof noteEvents.$inferSelect;
export type NoteVersion = typeof noteVersions.$inferSelect;
export type NoteCommentThread = typeof noteCommentThreads.$inferSelect;
export type NoteCommentMessage = typeof noteCommentMessages.$inferSelect;
export type NoteCommentMessageReaction = typeof noteCommentMessageReactions.$inferSelect;
export type NoteShareLink = typeof noteShareLinks.$inferSelect;
export type FolderShareLink = typeof folderShareLinks.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type NoteTag = typeof noteTags.$inferSelect;
export type NoteLink = typeof noteLinks.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type IntegrationAuthorization = typeof integrationAuthorizations.$inferSelect;
export type AuthorizationFolderRule = typeof authorizationFolderRules.$inferSelect;
export type ApiKeyCredential = typeof apiKeys.$inferSelect;
export type ApiKey = ApiKeyCredential & IntegrationAuthorization;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthConnection = typeof oauthAuthorizations.$inferSelect;
export type OAuthAuthorization = OAuthConnection & IntegrationAuthorization;
export type OAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;

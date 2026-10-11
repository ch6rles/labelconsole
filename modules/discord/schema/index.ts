import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';

/** A member's Discord account. One per member, and a Discord account links to one member per label. */
export const discordLinks = pgTable(
  'discord_links',
  {
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    discordUserId: text('discord_user_id').notNull(),
    /** Display only: the Discord username when the account was linked. */
    discordUsername: text('discord_username').notNull(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('discord_links_user_idx').on(t.orgId, t.userId), uniqueIndex('discord_links_discord_idx').on(t.orgId, t.discordUserId)],
);

/**
 * One-time codes a member types into /link. Only an HMAC of the code is
 * stored; a code lasts ten minutes and works once.
 */
export const discordLinkCodes = pgTable(
  'discord_link_codes',
  {
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('discord_link_codes_user_idx').on(t.orgId, t.userId)],
);

/** The last attempt to register the slash commands with Discord. */
export const discordState = pgTable(
  'discord_state',
  {
    ...tenantColumns(),
    applicationId: text('application_id'),
    commandsRegisteredAt: ts('commands_registered_at'),
    commandsError: text('commands_error'),
  },
  (t) => [uniqueIndex('discord_state_org_idx').on(t.orgId)],
);

export type DiscordLink = typeof discordLinks.$inferSelect;

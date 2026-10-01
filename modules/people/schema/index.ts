import { sql } from 'drizzle-orm';
import { date, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';

export const ARTIST_STATUSES = ['prospect', 'onboarding', 'active', 'paused', 'alumni'] as const;
export type ArtistStatus = (typeof ARTIST_STATUSES)[number];

export const ONBOARDING_STEPS = ['profile', 'taxForm', 'payout', 'contract', 'assets'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type Onboarding = Partial<Record<OnboardingStep, boolean>> & { next?: string };

export type Socials = { instagram?: string; tiktok?: string; x?: string; youtube?: string; website?: string; soundcloud?: string };

export const artists = pgTable(
  'artists',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    legalName: text('legal_name'),
    status: text('status').$type<ArtistStatus>().notNull().default('prospect'),
    country: text('country'),
    email: text('email'),
    manager: text('manager'),
    bio: text('bio'),
    socials: jsonb('socials').$type<Socials>().notNull().default({}),
    spotifyArtistId: text('spotify_artist_id'),
    youtubeChannelId: text('youtube_channel_id'),
    /** bank | paypal | none. Payout details themselves are never stored here. */
    payoutMethod: text('payout_method').notNull().default('none'),
    onboarding: jsonb('onboarding').$type<Onboarding>().notNull().default({}),
    onboardingOwnerId: uuid('onboarding_owner_id'),
    onboardingStartedAt: ts('onboarding_started_at'),
    rosterSince: date('roster_since'),
    notes: text('notes'),
  },
  (t) => [index('artists_org_name_idx').on(t.orgId, t.name), index('artists_org_status_idx').on(t.orgId, t.status)],
);

export const staffMembers = pgTable(
  'staff_members',
  {
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    title: text('title'),
    department: text('department'),
    phone: text('phone'),
    bio: text('bio'),
  },
  (t) => [index('staff_org_user_idx').on(t.orgId, t.userId)],
);

export type Artist = typeof artists.$inferSelect;
export type StaffMember = typeof staffMembers.$inferSelect;

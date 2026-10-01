import { sql } from 'drizzle-orm';
import { boards, cards } from '../schema';

/** A card counts toward a campaign through its own link or its board's. */
export const cardCampaign = sql<string | null>`coalesce(${cards.campaignId}, ${boards.campaignId})`;

/** Bookings are cards on creator boards: the creator ledger. */
export const isBooking = sql`${boards.kind} = 'creator'`;

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/**
 * Domain events. Modules extend `DomainEventMap` with declaration merging:
 *
 *   declare module '@labelconsole/core/events' {
 *     interface DomainEventMap { 'catalogue.track.imported': { trackId: string } }
 *   }
 *
 * Events are written to the `domain_events` outbox in the same transaction as
 * the change that caused them, then dispatched by the worker to listeners,
 * agent triggers and the realtime channel. Nothing is lost if a process dies
 * between commit and delivery.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainEventMap {}

export type EventType = keyof DomainEventMap & string;
export type EventPayload<K extends EventType> = DomainEventMap[K];

export type StoredEvent<K extends string = string> = {
  id: number;
  orgId: string;
  type: K;
  payload: K extends EventType ? DomainEventMap[K] : Record<string, unknown>;
  actor: string | null;
  createdAt: Date;
};

/** Redis channel the web app pings after commit so the dispatcher wakes immediately. */
export const OUTBOX_WAKE_CHANNEL = 'lc:outbox:wake';

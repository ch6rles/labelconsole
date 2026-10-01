export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'streams.snapshot.recorded': { trackId: string; platform: string; source: string; count: number; capturedAt: string };
    'streams.alert': { alertId: string; trackId: string; trackTitle: string; kind: string; platform: string; message: string; value: number };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'streams.schedule': Record<string, never>;
    'streams.resolve-track': { streamTrackId: string };
    'streams.poll-org': { force?: boolean };
    'streams.import-statement': { documentId: string };
    'streams.maintain-partitions': Record<string, never>;
  }
}

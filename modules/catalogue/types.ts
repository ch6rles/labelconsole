export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'catalogue.release.created': { releaseId: string; title: string; type: string; releaseDate: string | null };
    'catalogue.release.updated': { releaseId: string; title: string; changed: string[] };
    'catalogue.track.created': { trackId: string; title: string; isrc: string | null };
    'catalogue.track.imported': { trackId: string; isrc: string | null; releaseId: string | null; platformIds: Array<{ platform: string; externalId: string }> };
    'catalogue.demo.submitted': { demoId: string; title: string; artistName: string; source: string };
    'catalogue.demo.scored': { demoId: string; title: string; score: number };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'catalogue.resolve': { lookupId: string };
    'catalogue.bulk-import': { importId: string };
    'catalogue.recompute-blockers': { releaseId: string };
    'catalogue.import-credits': { trackIds: string[] | null };
  }
}

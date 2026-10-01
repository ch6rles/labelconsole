export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'people.artist.created': { artistId: string; name: string };
    'people.artist.updated': { artistId: string; name: string; changed: string[] };
    'people.artist.status_changed': { artistId: string; name: string; from: string; to: string };
  }
}

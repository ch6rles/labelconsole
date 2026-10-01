export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'inbox.notification.created': { notificationId: string; userId: string; kind: string };
  }
}

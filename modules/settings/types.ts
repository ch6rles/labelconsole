export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'settings.member.invited': { invitationId: string; email: string; role: string };
    'settings.member.role_changed': { membershipId: string; userId: string; role: string };
    'settings.export.ready': { exportId: string; requestedBy: string | null };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'settings.send-invite': { invitationId: string; url: string };
    'settings.export': { exportId: string };
    'settings.delete-org': { requestedBy: string };
  }
}

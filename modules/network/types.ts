export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'network.contact.created': { contactId: string; name: string; type: string };
    'network.interaction.logged': { interactionId: string; contactId: string; channel: string; direction: string; campaignId: string | null };
  }
}

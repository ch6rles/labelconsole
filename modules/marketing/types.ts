export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'marketing.campaign.created': { campaignId: string; name: string; releaseId: string | null };
    'marketing.campaign.started': { campaignId: string; name: string; releaseId: string | null };
    'marketing.card.moved': { cardId: string; boardId: string; from: string; to: string };
    'marketing.pitch.sent': { pitchId: string; contactId: string; campaignId: string | null };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'marketing.send-pitch': { pitchId: string; idempotencyKey: string };
  }
}

export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'documents.document.uploaded': { documentId: string; title: string; type: string };
    'documents.terms.extracted': { documentId: string; title: string; keyDates: number };
    'documents.terms.confirmed': { documentId: string; title: string };
    'documents.statement.parsed': { documentId: string; lines: number; periodStart: string | null; periodEnd: string | null };
    'documents.key_date.due': { keyDateId: string; documentId: string; title: string; date: string; daysLeft: number; kind: string };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'documents.extract': { documentId: string };
    'documents.parse-statement': { documentId: string };
    'documents.reminders': Record<string, never>;
    'documents.reminders-org': Record<string, never>;
  }
}

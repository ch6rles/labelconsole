import type { ModuleManifest } from '@labelconsole/core/modules';
import { FINANCE_SECTION } from '@labelconsole/catalogue/manifest';
import { PEOPLE_SECTION } from '@labelconsole/people/manifest';

export const DOCUMENTS_SECTION = { id: 'documents', label: 'Documents', icon: 'description', sub: 'Contracts, statements, key dates', order: 60 };

export const manifest: ModuleManifest = {
  id: 'documents',
  name: 'Documents',
  description: 'Contracts and statements with AI term extraction, versioning and date reminders.',
  icon: 'description',
  plans: ['starter', 'growth', 'scale'],
  dependsOn: ['drive'],
  permissions: [
    { key: 'documents:read', description: 'View non-confidential documents' },
    { key: 'documents:write', description: 'Upload, tag, link and confirm documents' },
    { key: 'documents:delete', description: 'Delete documents' },
    { key: 'documents:read_financial', description: 'View statements, royalties and amounts', sensitive: true },
    { key: 'documents:read_confidential', description: 'Open documents marked confidential', sensitive: true },
  ],
  nav: [
    {
      section: DOCUMENTS_SECTION,
      tabs: [
        { id: 'all', label: 'All documents', href: '/documents', permission: 'documents:read', order: 10 },
        { id: 'key-dates', label: 'Key dates', href: '/documents/key-dates', permission: 'documents:read', order: 20 },
      ],
    },
    { section: PEOPLE_SECTION, tabs: [{ id: 'contracts', label: 'Contracts', href: '/people/contracts', permission: 'documents:read', order: 30 }] },
    {
      section: FINANCE_SECTION,
      tabs: [
        { id: 'royalties', label: 'Royalties', href: '/finance/royalties', permission: 'documents:read_financial', order: 10 },
        { id: 'statements', label: 'Statements', href: '/finance/statements', permission: 'documents:read_financial', order: 20 },
      ],
    },
  ],
  events: { emits: ['documents.document.uploaded', 'documents.terms.extracted', 'documents.terms.confirmed', 'documents.statement.parsed', 'documents.key_date.due'], listens: [] },
  tools: ['documents_read', 'documents_extract_terms', 'documents_summarize_statement', 'documents_upcoming_dates'],
};

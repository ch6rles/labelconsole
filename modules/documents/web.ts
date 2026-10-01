import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import ContractsPage from './ui/contracts';
import DocumentDetailPage from './ui/document-detail';
import DocumentsPage from './ui/documents';
import KeyDatesPage from './ui/key-dates';
import { documentsPanel } from './ui/panels';
import RoyaltiesPage from './ui/royalties';
import StatementsPage from './ui/statements';

export default defineWeb({
  manifest,
  pages: [
    { path: 'documents', permission: 'documents:read', component: DocumentsPage },
    { path: 'documents/key-dates', permission: 'documents:read', component: KeyDatesPage },
    { path: 'documents/:id', permission: 'documents:read', component: DocumentDetailPage },
    { path: 'people/contracts', permission: 'documents:read', component: ContractsPage },
    { path: 'finance/royalties', permission: 'documents:read_financial', component: RoyaltiesPage },
    { path: 'finance/statements', permission: 'documents:read_financial', component: StatementsPage },
  ],
  panels: [
    { id: 'documents-artist', entityType: 'artist', title: 'Contracts & documents', order: 20, permission: 'documents:read', component: documentsPanel('artist', 'contract') },
    { id: 'documents-release', entityType: 'release', title: 'Documents', order: 30, permission: 'documents:read', component: documentsPanel('release', 'other') },
  ],
});

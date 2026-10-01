import type { ModuleManifest } from '@labelconsole/core/modules';
import { MARKETING_SECTION } from '@labelconsole/network/manifest';

export const manifest: ModuleManifest = {
  id: 'marketing',
  name: 'Marketing',
  description: 'Campaigns tied to releases, creator and editor pipelines, outreach tracking and sketchboards.',
  icon: 'campaign',
  plans: ['growth', 'scale'],
  dependsOn: ['catalogue', 'network'],
  permissions: [
    { key: 'marketing:read', description: 'View campaigns, pipelines and outreach' },
    { key: 'marketing:write', description: 'Create and edit campaigns, cards, pitches and sketchboards' },
    { key: 'marketing:delete', description: 'Delete campaigns and boards' },
    { key: 'marketing:spend', description: 'Record payments and offers to creators', sensitive: true },
  ],
  nav: [
    {
      section: MARKETING_SECTION,
      tabs: [
        { id: 'overview', label: 'Overview', href: '/marketing', permission: 'marketing:read', order: 10 },
        { id: 'campaigns', label: 'Campaigns', href: '/marketing/campaigns', permission: 'marketing:read', order: 20 },
        { id: 'pipelines', label: 'Pipelines', href: '/marketing/pipelines', permission: 'marketing:read', order: 30 },
        { id: 'outreach', label: 'Outreach', href: '/marketing/outreach', permission: 'marketing:read', order: 40 },
        { id: 'sketchboards', label: 'Sketchboards', href: '/marketing/sketchboards', permission: 'marketing:read', order: 50 },
      ],
    },
  ],
  events: { emits: ['marketing.campaign.created', 'marketing.campaign.started', 'marketing.card.moved', 'marketing.pitch.sent'], listens: [] },
  tools: ['marketing_create_campaign', 'marketing_list_campaigns', 'marketing_move_pipeline_card', 'marketing_add_pipeline_card', 'marketing_draft_outreach', 'marketing_send_outreach'],
};

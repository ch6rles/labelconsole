import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import CampaignDetailPage from './ui/campaign-detail';
import CampaignsPage from './ui/campaigns';
import OutreachPage from './ui/outreach';
import MarketingOverviewPage from './ui/overview';
import { contactMarketingPanel, releaseCampaignsPanel } from './ui/panels';
import PipelinesPage from './ui/pipelines';
import { SketchboardPage, SketchboardsPage } from './ui/sketchboards';

export default defineWeb({
  manifest,
  pages: [
    { path: 'marketing', permission: 'marketing:read', component: MarketingOverviewPage },
    { path: 'marketing/campaigns', permission: 'marketing:read', component: CampaignsPage },
    { path: 'marketing/campaigns/:id', permission: 'marketing:read', component: CampaignDetailPage },
    { path: 'marketing/pipelines', permission: 'marketing:read', component: PipelinesPage },
    { path: 'marketing/outreach', permission: 'marketing:read', component: OutreachPage },
    { path: 'marketing/sketchboards', permission: 'marketing:read', component: SketchboardsPage },
    { path: 'marketing/sketchboards/:id', permission: 'marketing:read', component: SketchboardPage },
  ],
  panels: [
    { id: 'marketing-release-campaigns', entityType: 'release', title: 'Campaigns', order: 25, permission: 'marketing:read', component: releaseCampaignsPanel },
    { id: 'marketing-contact', entityType: 'contact', title: 'Bookings & outreach', order: 10, permission: 'marketing:read', component: contactMarketingPanel },
  ],
});

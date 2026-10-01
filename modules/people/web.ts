import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import ArtistDetailPage from './ui/artist-detail';
import ArtistsPage from './ui/artists';
import OnboardingPage from './ui/onboarding';
import StaffPage from './ui/staff';

export default defineWeb({
  manifest,
  pages: [
    { path: 'people/artists', permission: 'people:read', component: ArtistsPage },
    { path: 'people/artists/:id', permission: 'people:read', component: ArtistDetailPage },
    { path: 'people/onboarding', permission: 'people:read', component: OnboardingPage },
    { path: 'people/staff', permission: 'people:read', component: StaffPage },
  ],
});

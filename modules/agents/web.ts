import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import AgentDetailPage from './ui/agent-detail';
import AgentsPage from './ui/agents';
import ApprovalsPage from './ui/approvals';
import MemoryPage from './ui/memory';
import NewAgentPage from './ui/new-agent';
import RunDetailPage from './ui/run-detail';
import RunsPage from './ui/runs';
import UsagePage from './ui/usage';

export default defineWeb({
  manifest,
  pages: [
    { path: 'agents', permission: 'agents:read', component: AgentsPage },
    { path: 'agents/new', permission: 'agents:manage', component: NewAgentPage },
    { path: 'agents/runs', permission: 'agents:read', component: RunsPage },
    { path: 'agents/runs/:id', permission: 'agents:read', component: RunDetailPage },
    { path: 'agents/memory', permission: 'agents:read', component: MemoryPage },
    { path: 'agents/usage', permission: 'agents:read', component: UsagePage },
    { path: 'agents/:id', permission: 'agents:read', component: AgentDetailPage },
    // The Approvals tab lives in the Inbox; the Inbox shows a placeholder when Agents is off.
    { path: 'inbox/approvals', permission: 'agents:read', component: ApprovalsPage },
  ],
});

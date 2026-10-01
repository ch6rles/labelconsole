import type { ModuleManifest } from '@labelconsole/core/modules';

export const manifest: ModuleManifest = {
  id: 'agents',
  name: 'Agents',
  description: 'Autonomous AI agents that work through the same services and permissions as staff.',
  icon: 'smart_toy',
  plans: ['growth', 'scale'],
  permissions: [
    { key: 'agents:read', description: 'View agents, runs, steps and memory' },
    { key: 'agents:run', description: 'Start, pause and stop agent runs' },
    { key: 'agents:manage', description: 'Create and edit agents, triggers, budgets and memory' },
    { key: 'agents:approve', description: 'Approve or reject risky agent actions' },
  ],
  nav: [
    {
      section: { id: 'agents', label: 'Agents', icon: 'smart_toy', sub: 'Autonomous AI agents', order: 80 },
      tabs: [
        { id: 'agents', label: 'Agents', href: '/agents', permission: 'agents:read', order: 10 },
        { id: 'runs', label: 'Runs', href: '/agents/runs', permission: 'agents:read', order: 20 },
        { id: 'memory', label: 'Memory', href: '/agents/memory', permission: 'agents:read', order: 30 },
        { id: 'usage', label: 'Usage', href: '/agents/usage', permission: 'agents:read', order: 40 },
      ],
    },
  ],
  events: { emits: ['agents.run.started', 'agents.run.completed', 'agents.run.failed', 'agents.approval.requested', 'agents.approval.decided'], listens: ['*'] },
  tools: ['agents_list', 'agents_delegate_task', 'agents_remember', 'agents_recall'],
};

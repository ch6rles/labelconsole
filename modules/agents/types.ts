export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'agents.run.started': { runId: string; agentId: string; agentName: string };
    'agents.run.completed': { runId: string; agentId: string; agentName: string; parentRunId: string | null; result: string | null; costUsd: number };
    'agents.run.failed': { runId: string; agentId: string; agentName: string; ownerUserId: string; error: string; parentRunId: string | null; status: string };
    'agents.approval.requested': { approvalId: string; runId: string; agentId: string; agentName: string; ownerUserId: string; tool: string; preview: string; risk: string };
    'agents.approval.decided': { approvalId: string; runId: string; status: string; decidedBy: string };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'agents.run': { runId: string };
    'agents.tick': Record<string, never>;
    /** orgId null: find labels with memories to embed and fan out; with an org: embed its pending memories. */
    'agents.embed-memories': Record<string, never>;
  }
}

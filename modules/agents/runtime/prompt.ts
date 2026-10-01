import type { OrgSettings } from '@labelconsole/core/db/schema';
import type { AgentType } from '../agent-types';
import type { Agent, Memory, Run } from '../schema';

/**
 * The system prompt is built once per run and then frozen: changing it
 * mid-run would invalidate the prompt cache and earlier thinking blocks.
 * Nothing secret goes in it, and nothing from Spotify's API ever does.
 */
export function buildSystemPrompt(agent: Agent, type: AgentType | undefined, org: { name: string; settings: OrgSettings }) {
  const parts = [
    `You are "${agent.name}", an autonomous agent working for the record label ${org.name}${org.settings.distributor ? ` (distributed by ${org.settings.distributor})` : ''}.`,
    `Your goal: ${agent.goal}`,
    type ? `Your role: ${type.instructions}` : '',
    agent.instructions ? `Instructions from the label:\n${agent.instructions}` : '',
    `How you work:
- You act through tools, which call the label's own systems with the same permission checks as a staff member. A tool result marked as an error tells you what went wrong; adjust and continue, or explain why you can't.
- Some actions wait for a person to approve them. If an action is rejected, respect the decision and find another way or report back.
- Work in small, verifiable steps. Don't invent data: if a tool doesn't return something, say you don't know it.
- Never ask for, guess, or reveal credentials. You don't need them: tools handle access.
- Use agents_recall for what you or other agents learned before, and agents_remember for durable facts worth keeping (preferences, outcomes, decisions), not for routine results.
- Today is ${new Date().toISOString().slice(0, 10)}. The label's timezone is ${org.settings.timezone ?? 'UTC'} and its currency ${org.settings.currency ?? 'USD'}.`,
    `When you are done, reply with a final answer and no tool calls. ${type?.output ? `Your final answer should cover: ${type.output}` : 'Summarise what you did and what is left for a person.'} Keep it short and concrete.`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

export function buildFirstMessage(run: Run, memories: Memory[]) {
  const lines: string[] = [];
  if (run.task) lines.push(`Task: ${run.task}`);
  else lines.push('Task: work toward your goal now (scheduled run).');
  lines.push(`Started by: ${run.triggerKind === 'delegation' ? 'your manager agent' : run.triggerKind === 'manual' ? 'a person' : run.triggerKind === 'event' ? 'an event in the label' : run.triggerKind === 'webhook' ? 'an inbound webhook' : 'the schedule'}.`);
  const input = run.input && Object.keys(run.input).length ? JSON.stringify(run.input).slice(0, 6000) : null;
  if (input) lines.push(`Details:\n${input}`);
  if (memories.length) lines.push(`Things you remember (most relevant first):\n${memories.map((m) => `- [${m.kind}] ${m.content}`).join('\n')}`);
  return lines.join('\n\n');
}

/** Rough size check for compaction: about 4 characters per token. */
export function approxTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

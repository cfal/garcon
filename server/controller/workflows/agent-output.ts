import { workflowCommit, workflowEnum, workflowRecord, workflowText } from '../../../common/workflow-validation.js';
import type { WorkflowTaskSpec } from '../../../common/workflows.js';

export function workflowAgentPrompt(spec: Extract<WorkflowTaskSpec, { kind: 'agent' }>, inputCommit: string): string {
  if (spec.outputs.includes('commit')) return `${spec.prompt.trim()}\n\nCommit the completed changes on the current branch and leave the worktree clean. `
    + `Preserve ancestry from input commit ${inputCommit}.`;
  if (!spec.outputs.includes('review')) return spec.prompt.trim();
  return `${spec.prompt.trim()}\n\nReview input commit: ${inputCommit}. Leave the checkout unchanged. `
    + 'The final response must be one JSON object with exactly these fields: '
    + '"commit" (the reviewed full commit ID), "decision" ("accept" or "reject"), '
    + 'and "summary" (a nonempty review summary). Do not wrap the JSON in Markdown.';
}

export function parseWorkflowReview(text: string): { commit: string; decision: 'accept' | 'reject'; summary: string } | null {
  try {
    const value = workflowRecord(JSON.parse(text), ['commit', 'decision', 'summary']);
    return { commit: workflowCommit(value.commit), decision: workflowEnum(value.decision, ['accept', 'reject']),
      summary: workflowText(value.summary, 'review summary', 16 * 1024) };
  } catch { return null; }
}

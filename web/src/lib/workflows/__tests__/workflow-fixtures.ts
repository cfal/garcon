import { parseWorkflowDefinition } from '$shared/workflow-definition';
import type { WorkflowRevision, WorkflowRunDetail } from '$shared/workflow-runs';

const source = `# Reviewed source comment
version: 1
name: Review a report
inputs:
  title: { type: string }
  count: { type: number }
  failed: { type: boolean }
  evidence: { type: json }
steps:
  - id: review
    kind: decision
    name: Review report
    prompt: Check this example. # preserve inline comment
    choices: { approve: Approve report, reject: Reject report }
`;

export function workflowRevision(): WorkflowRevision {
	const { definition } = parseWorkflowDefinition(source);
	if (!definition) throw new Error('Invalid synthetic workflow fixture');
	return {
		definitionId: 'review-def',
		revision: 3,
		source,
		definition,
		publishedAt: '2026-11-21T12:00:00Z',
	};
}

const repeatSource = `version: 1
name: Verify research
steps:
  - id: research
    kind: agent
    prompt: Find a claim.
    signals:
      found: { payload: json, delivery: many, key: id, fields: { id: string, claim: string } }
  - id: verify
    name: Verify findings
    kind: agent
    prompt: Check claim.
    on: { kind: each, signal: research.found, maxConcurrency: 2 }
  - id: review
    name: Review report
    kind: decision
    prompt: Accept the findings?
    choices: { approve: Approve report, reject: Reject report }
`;

export function workflowRun(): WorkflowRunDetail {
	const { definition } = parseWorkflowDefinition(repeatSource);
	if (!definition) throw new Error('Invalid synthetic repeat workflow fixture');
	const createdAt = '2026-11-21T12:00:00Z';
	const location = { executorId: 'local', projectPath: '/fixture' };
	return {
		id: 'run-a',
		kind: 'published',
		definitionId: 'repeat-def',
		revision: 1,
		name: definition.name,
		status: 'attention',
		createdAt,
		updatedAt: createdAt,
		pinnedRevision: {
			definition,
			source: repeatSource,
			definitionId: 'repeat-def',
			revision: 1,
			publishedAt: createdAt,
		},
		inputs: {},
		executionContext: { defaultTarget: location },
		amendments: [],
		archive: null,
		steps: [
			{
				step: definition.steps[0],
				location,
				settings: { kind: 'agent' },
				intake: 'closed',
				waitingReason: 'Still collecting',
				instances: [],
			},
			{
				step: definition.steps[1],
				location,
				settings: { kind: 'agent' },
				intake: 'open',
				waitingReason: null,
				instances: [
					{
						id: 'verify-a',
						key: 'F-01',
						status: 'succeeded',
						trigger: { kind: 'signal', signalId: 'report-a' },
						bindings: { claim: 'A claim.' },
						prompt: 'Check the claim.',
						reason: null,
						attempts: [
							{
								id: 'attempt-1',
								number: 1,
								status: 'succeeded',
								chatId: '1780000000000001',
								chatAvailable: true,
								turnId: 'verify-turn-a',
								startedAt: createdAt,
								finishedAt: createdAt,
								reason: null,
							},
						],
					},
					{
						id: 'verify-b',
						key: 'F-02',
						status: 'unknown',
						trigger: { kind: 'signal', signalId: 'report-b' },
						bindings: null,
						prompt: null,
						reason: 'Connection lost',
						attempts: [
							{
								id: 'attempt-2',
								number: 1,
								status: 'unknown',
								chatId: '1780000000000002',
								chatAvailable: true,
								turnId: 'verify-turn-b',
								startedAt: createdAt,
								finishedAt: createdAt,
								reason: null,
							},
						],
					},
				],
			},
			{
				step: definition.steps[2],
				location: null,
				settings: null,
				intake: 'closed',
				waitingReason: null,
				instances: [
					{
						id: 'decide',
						key: null,
						status: 'awaiting-decision',
						trigger: { kind: 'root' },
						bindings: null,
						prompt: 'Accept the findings?',
						reason: null,
						attempts: [],
					},
				],
			},
		],
		signals: [
			{
				id: 'report-a',
				runId: 'run-a',
				ref: { stepId: 'research', signal: 'found' },
				key: 'F-01',
				instanceId: 'research-a',
				source: {
					kind: 'attempt',
					attemptId: 'research-attempt',
					chatId: '1780000000000003',
					turnId: 'research-turn',
				},
				payload: { id: 'F-01', claim: 'A claim.' },
				createdAt,
			},
			{
				id: 'report-b',
				runId: 'run-a',
				ref: { stepId: 'research', signal: 'found' },
				key: 'F-02',
				instanceId: 'research-a',
				source: {
					kind: 'attempt',
					attemptId: 'research-attempt',
					chatId: '1780000000000003',
					turnId: 'research-turn',
				},
				payload: { id: 'F-02', claim: 'Another claim.' },
				createdAt,
			},
		],
	};
}

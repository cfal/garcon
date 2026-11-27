import * as m from '$lib/paraglide/messages.js';

export interface WorkflowStarterTemplate {
	readonly id: 'review-gate' | 'command-approval' | 'fan-out-synthesis';
	readonly title: string;
	readonly summary: string;
	readonly source: string;
}

export const WORKFLOW_STARTER_TEMPLATES: readonly WorkflowStarterTemplate[] = [
	{
		id: 'review-gate',
		get title() {
			return m.workflow_studio_template_review_title();
		},
		get summary() {
			return m.workflow_studio_template_review_summary();
		},
		source: `version: 1
name: Draft and review
inputs:
  goal:
    type: string
    description: What the draft should accomplish
steps:
  - id: draft
    name: Draft proposal
    kind: agent
    bindings: { goal: inputs.goal }
    prompt: |
      Prepare a clear proposal for: {{goal}}
  - id: review
    name: Human review
    kind: decision
    on: { kind: once, signal: draft.turn_completed }
    bindings: { draft: signal }
    prompt: |
      {{draft}}

      Approve this draft?
    choices:
      approve: Approve
      reject: Request changes
`,
	},
	{
		id: 'command-approval',
		get title() {
			return m.workflow_studio_template_command_title();
		},
		get summary() {
			return m.workflow_studio_template_command_summary();
		},
		source: `version: 1
name: Command check and approval
steps:
  - id: check
    name: Inspect workspace
    kind: command
    command: git status --short
  - id: approve
    name: Approve action
    kind: decision
    on: { kind: once, signal: check.turn_completed }
    bindings: { output: signal }
    prompt: |
      {{output}}

      Proceed with the agent follow-up?
    choices:
      approve: Approve
      reject: Stop
  - id: apply
    name: Apply follow-up
    kind: agent
    on: { kind: once, signal: approve.approve }
    prompt: |
      Proceed with the approved follow-up in this folder.
`,
	},
	{
		id: 'fan-out-synthesis',
		get title() {
			return m.workflow_studio_template_fanout_title();
		},
		get summary() {
			return m.workflow_studio_template_fanout_summary();
		},
		source: `version: 1
name: Parallel fan-out and synthesis
inputs:
  topic:
    type: string
    description: Subject to split into parallel tasks
steps:
  - id: plan
    name: Plan work items
    kind: agent
    bindings: { topic: inputs.topic }
    signals:
      item:
        payload: json
        delivery: many
        key: id
        fields: { id: string, task: string }
    prompt: |
      Break {{topic}} into independent tasks and emit one standalone envelope per task:
      <garcon-workflow-emit signal="plan.item" content-type="json">{"id":"item-1","task":"Describe task"}</garcon-workflow-emit>
  - id: work
    name: Handle item
    kind: agent
    on: { kind: each, signal: plan.item, maxConcurrency: 3 }
    bindings: { item: signal }
    prompt: |
      Complete this assigned item concisely: {{item}}
  - id: synthesize
    name: Synthesize results
    kind: agent
    on: { kind: all, close: plan.turn_completed, steps: [work] }
    bindings: { results: all.work }
    prompt: |
      Synthesize these worker results into a final summary: {{results}}
`,
	},
];

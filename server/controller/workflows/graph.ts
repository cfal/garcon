import { WORKFLOW_LIMITS, type WorkflowPlan, type WorkflowPlanTask } from '../../../common/workflows.js';
import { workflowInvalid } from '../../../common/workflow-validation.js';

export function workflowOrder(plan: WorkflowPlan): readonly string[] {
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  if (byId.size !== plan.tasks.length) return workflowInvalid('Duplicate task identities.');
  const remaining = new Map<string, number>();
  const children = new Map<string, string[]>();
  let edges = 0;
  for (const task of plan.tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      if (dependency === task.id || !byId.has(dependency)) return workflowInvalid(`Invalid dependency of ${task.id}.`);
      const list = children.get(dependency) ?? [];
      list.push(task.id);
      children.set(dependency, list);
      edges++;
    }
  }
  if (edges > WORKFLOW_LIMITS.edges) return workflowInvalid('Too many workflow edges.');
  const ready = plan.tasks.filter(task => task.dependsOn.length === 0).map(task => task.id);
  const order: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== plan.tasks.length) return workflowInvalid('Workflow dependencies contain a cycle.');
  return order;
}

export function validateWorkflowGraph(plan: WorkflowPlan): void {
  workflowOrder(plan);
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  if (!plan.goal.taskIds.length || plan.goal.taskIds.some(id => !byId.has(id))) return workflowInvalid('Unresolved workflow goal.');
  if (plan.goal.kind === 'pr-open' && plan.goal.taskIds.some(id => byId.get(id)?.spec.kind !== 'publish-pr')) {
    return workflowInvalid('PR-open goals require publication tasks.');
  }
  for (const task of plan.tasks) {
    const requireDependency = (id: string): WorkflowPlanTask => {
      const referenced = byId.get(id);
      if (!referenced || !task.dependsOn.includes(id)) return workflowInvalid(`Unresolved input ${id} in ${task.id}.`);
      return referenced;
    };
    for (const acceptance of task.acceptance) {
      if (acceptance.kind === 'artifact') {
        if (task.spec.kind !== 'agent' || !task.spec.outputs.includes(acceptance.output)) return workflowInvalid('Acceptance names an undeclared output.');
      } else {
        const source = requireDependency(acceptance.taskId);
        if (acceptance.kind === 'approval' ? source.spec.kind !== 'approval'
          : source.spec.kind !== 'agent' || !source.spec.outputs.includes('review')) return workflowInvalid('Invalid acceptance dependency.');
      }
    }
    if (task.spec.kind === 'integrate') {
      if (!task.spec.inputs.length) return workflowInvalid('Integration requires commits.');
      task.spec.inputs.forEach(id => requireCommitOutput(requireDependency(id)));
    }
    if (task.spec.kind === 'approval') task.spec.requirements.forEach(requireDependency);
    if (task.spec.kind === 'publish-pr') {
      if (!plan.policy.allowRemoteWrites || !task.spec.target.remote) return workflowInvalid('Publication requires approved remote writes.');
      requireCommitOutput(requireDependency(task.spec.sourceTaskId));
      const gate = requireDependency(task.spec.approvalTaskId);
      if (gate.spec.kind !== 'approval' || gate.spec.purpose !== 'publication'
        || !gate.dependsOn.includes(task.spec.sourceTaskId)) return workflowInvalid('Publication requires a gate over its source commit.');
      if (task.retry.maxAttempts !== 1) return workflowInvalid('Publication is reconciled, never automatically repeated.');
    }
    if ('target' in task.spec) {
      for (const id of task.dependsOn) {
        const dependency = byId.get(id)!;
        if ('target' in dependency.spec && dependency.spec.target.executorId !== task.spec.target.executorId) {
          if (!plan.policy.allowRemoteWrites || !task.spec.target.remote || !dependency.spec.target.remote
            || task.spec.target.repositoryId !== dependency.spec.target.repositoryId
            || task.spec.target.remote.url !== dependency.spec.target.remote.url) {
            return workflowInvalid('Cross-executor inputs require an explicitly shared approved remote.');
          }
        }
      }
    }
  }
}

function requireCommitOutput(task: WorkflowPlanTask): void {
  if (task.spec.kind !== 'integrate' && (task.spec.kind !== 'agent' || !task.spec.outputs.includes('commit'))) {
    workflowInvalid('Input task does not declare a commit.');
  }
}

export function workflowDescendants(plan: WorkflowPlan, roots: ReadonlySet<string>): Set<string> {
  const result = new Set(roots);
  for (const id of workflowOrder(plan)) {
    const task = plan.tasks.find(entry => entry.id === id)!;
    if (task.dependsOn.some(dependency => result.has(dependency))) result.add(id);
  }
  return result;
}

export function workflowMermaid(plan: WorkflowPlan): string {
  const labels = new Map(plan.tasks.map((task, index) => [task.id, `n${index}`]));
  // Entity encoding keeps untrusted labels out of Mermaid's directive and link syntax.
  const label = (text: string) => Array.from(text).map(char => /[a-zA-Z0-9 ]/u.test(char) ? char : `#${char.codePointAt(0)};`).join('');
  return ['flowchart TD', ...plan.tasks.map(task => `  ${labels.get(task.id)}["${label(task.title)}"]`),
    ...plan.tasks.flatMap(task => task.dependsOn.map(id => `  ${labels.get(id)} --> ${labels.get(task.id)}`))].join('\n');
}

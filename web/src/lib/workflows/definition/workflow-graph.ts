import type { WorkflowStep } from '$shared/workflow-definition';

export interface WorkflowGraphNode {
	id: string;
	title: string;
	kind: WorkflowStep['kind'];
	detail?: string;
}

export interface WorkflowGraphEdge {
	source: string;
	target: string;
	label: string;
}

export function workflowEdges(steps: readonly WorkflowStep[]): WorkflowGraphEdge[] {
	return steps.flatMap(({ id, on }): WorkflowGraphEdge[] => {
		if (!on) return [];
		if (on.kind === 'all') {
			return [
				{ source: on.close.stepId, target: id, label: on.close.signal },
				...on.steps.map((stepId) => ({ source: stepId, target: id, label: '' })),
			];
		}
		return [{ source: on.signal.stepId, target: id, label: on.signal.signal }];
	});
}

export function workflowGraphPositions(
	nodes: readonly WorkflowGraphNode[],
	edges: readonly WorkflowGraphEdge[],
): Map<string, { x: number; y: number }> {
	const pending = new Map(nodes.map(({ id }) => [id, 0]));
	const outgoing = new Map<string, string[]>();
	for (const { source, target } of edges) {
		if (!pending.has(source) || !pending.has(target)) continue;
		if (!outgoing.has(source)) outgoing.set(source, []);
		outgoing.get(source)!.push(target);
		pending.set(target, pending.get(target)! + 1);
	}
	const ready = nodes.filter(({ id }) => pending.get(id) === 0).map(({ id }) => id);
	const depths = new Map<string, number>();
	for (const source of ready) {
		for (const target of outgoing.get(source) ?? []) {
			depths.set(target, Math.max(depths.get(target) ?? 0, (depths.get(source) ?? 0) + 1));
			const count = pending.get(target)! - 1;
			pending.set(target, count);
			if (!count) ready.push(target);
		}
	}
	const rows = new Map<number, number>();
	return new Map(
		nodes.map(({ id }) => {
			const depth = depths.get(id) ?? 0;
			const row = rows.get(depth) ?? 0;
			rows.set(depth, row + 1);
			return [id, { x: depth * 300, y: row * 100 }];
		}),
	);
}

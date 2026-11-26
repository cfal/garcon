import { describe, expect, it } from 'vitest';
import { workflowGraphPositions } from '../workflow-graph';
import { workflowStepTone } from '../../run/workflow-run-projection';
import { workflowRun } from '$lib/workflows/__tests__/workflow-fixtures';

describe('workflow graph layout and status tones', () => {
	it('spaces DAG layers by 380x124 coordinates so node cards and edge labels do not crowd', () => {
		const positions = workflowGraphPositions(
			[
				{ id: 'plan', title: 'Plan', kind: 'agent' },
				{ id: 'worker-a', title: 'Worker A', kind: 'agent' },
				{ id: 'worker-b', title: 'Worker B', kind: 'command' },
				{ id: 'join', title: 'Join', kind: 'decision' },
			],
			[
				{ source: 'plan', target: 'worker-a', label: 'item' },
				{ source: 'plan', target: 'worker-b', label: 'item' },
				{ source: 'worker-a', target: 'join', label: 'turn_completed' },
				{ source: 'worker-b', target: 'join', label: 'turn_completed' },
			],
		);

		expect(positions.get('plan')).toEqual({ x: 0, y: 0 });
		expect(positions.get('worker-a')).toEqual({ x: 380, y: 0 });
		expect(positions.get('worker-b')).toEqual({ x: 380, y: 124 });
		expect(positions.get('join')).toEqual({ x: 760, y: 0 });
	});

	it('derives semantic status tones from step instances', () => {
		const run = workflowRun();
		const [pending, mixed, waiting] = run.steps;
		expect(workflowStepTone(pending!)).toBe('neutral');
		expect(workflowStepTone(mixed!)).toBe('error');
		expect(workflowStepTone(waiting!)).toBe('warning');

		const succeeded = {
			...mixed!,
			instances: [mixed!.instances[0]!],
		};
		expect(workflowStepTone(succeeded)).toBe('success');

		const running = {
			...mixed!,
			instances: [{ ...mixed!.instances[0]!, status: 'running' as const }],
		};
		expect(workflowStepTone(running)).toBe('info');
	});
});

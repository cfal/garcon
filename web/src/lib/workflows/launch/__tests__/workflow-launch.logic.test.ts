import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '$shared/workflow-definition';
import { decodeWorkflowInputs, parseWorkflowJson } from '../workflow-inputs';
import { workflowLocations } from '../workflow-locations';

describe('workflow launch', () => {
	it('preserves false, zero, null and exact strings, but rejects non-finite JSON', () => {
		expect(
			decodeWorkflowInputs(
				{
					enabled: { type: 'boolean' },
					count: { type: 'number' },
					data: { type: 'json' },
					text: { type: 'string' },
					other: { type: 'number', default: 42 },
				},
				{ enabled: 'false', count: '0', data: 'null', text: '  user text \n' },
			),
		).toEqual({
			inputs: { enabled: false, count: 0, data: null, text: '  user text \n', other: 42 },
			errors: {},
		});
		expect(() => parseWorkflowJson('{"overflow": 1e3010}')).toThrow();
	});

	it('asks for an inherited folder once per executor and never applies a Local path to Remote', () => {
		const steps = [
			{ kind: 'agent', id: 'one', prompt: 'Run.' },
			{ kind: 'agent', id: 'two', prompt: 'Run.', executorId: 'remote-a' },
			{ kind: 'command', id: 'three', command: 'pwd', executorId: 'remote-a' },
			{
				kind: 'command',
				id: 'four',
				command: 'pwd',
				executorId: 'remote-b',
				projectPath: '/checkout',
			},
			{ kind: 'decision', id: 'five', prompt: 'Ready?', choices: { yes: 'Yes' } },
		] satisfies WorkflowStep[];
		expect(workflowLocations(steps, 'local', { local: '/checkout' }).missingFolders).toEqual([
			'remote-a',
		]);
		expect(
			workflowLocations(steps, 'local', { local: '/checkout', 'remote-a': '/other' })
				.executionContext,
		).toEqual({
			defaultTarget: { executorId: 'local', projectPath: '/checkout' },
			projectPaths: { local: '/checkout', 'remote-a': '/other' },
		});
		expect(workflowLocations([steps[4]], 'local', {}).executionContext).toEqual({});
	});
});

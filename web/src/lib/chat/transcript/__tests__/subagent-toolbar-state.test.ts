import { describe, expect, it, vi } from 'vitest';
import { SubagentToolbarState } from '../subagent-toolbar-state.svelte.js';
import type { SubagentManagementModel } from '../subagent-management.js';

function makeModel(id: string): SubagentManagementModel {
	return {
		entries: [
			{
				id: 'root',
				kind: 'root',
				name: 'Main chat',
				status: 'idle',
				statusLabel: 'Idle',
			},
			{
				id,
				kind: 'subagent',
				name: id,
				status: 'running',
				statusLabel: 'Running',
				anchorId: `tool-input-${id}`,
			},
		],
		subagents: [
			{
				id,
				kind: 'subagent',
				name: id,
				status: 'running',
				statusLabel: 'Running',
				anchorId: `tool-input-${id}`,
			},
		],
	};
}

describe('SubagentToolbarState', () => {
	it('exposes a live registered model and delegates navigation', () => {
		const toolbar = new SubagentToolbarState();
		const jumpToTool = vi.fn();
		let model = makeModel('research');

		toolbar.register({
			get model() {
				return model;
			},
			jumpToTool,
		});

		expect(toolbar.model).toBe(model);
		model = makeModel('review');
		expect(toolbar.model).toBe(model);

		toolbar.jumpToTool('tool-input-review');
		expect(jumpToTool).toHaveBeenCalledWith('tool-input-review');
	});

	it('clears its source when the registration is released', () => {
		const toolbar = new SubagentToolbarState();
		const unregister = toolbar.register({
			model: makeModel('research'),
			jumpToTool: vi.fn(),
		});

		unregister();

		expect(toolbar.model).toBeNull();
	});

	it('does not let stale cleanup clear a replacement source', () => {
		const toolbar = new SubagentToolbarState();
		const unregisterFirst = toolbar.register({
			model: makeModel('research'),
			jumpToTool: vi.fn(),
		});
		const replacement = makeModel('review');
		toolbar.register({
			model: replacement,
			jumpToTool: vi.fn(),
		});

		unregisterFirst();

		expect(toolbar.model).toBe(replacement);
	});
});

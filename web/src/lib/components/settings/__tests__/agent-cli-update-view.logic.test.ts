import { describe, expect, it } from 'vitest';
import type { AgentCliUpdateStatus } from '$shared/agent-cli-update';
import { agentCliUpdateView } from '../agent-cli-update-view.js';

const BEHIND: AgentCliUpdateStatus = {
	cliLabel: 'Codex CLI',
	installMethod: 'npm',
	installPath: '/opt/synthetic/lib/node_modules/@openai/codex/bin/codex.js',
	currentVersion: '0.169.0',
	latestVersion: '0.170.0',
	advisory: 'behind-latest',
	updateCommand: 'npm install -g --prefix /opt/synthetic @openai/codex@latest',
	canUpdate: true,
	message: null,
	checkedAt: '2026-11-20T00:00:00.000Z',
	run: { state: 'idle', startedAt: null, finishedAt: null, message: null, output: null },
};

describe('agentCliUpdateView', () => {
	it('offers a one-click update only when the CLI is behind and Garcon can run its installer', () => {
		expect(agentCliUpdateView(BEHIND)).toEqual({ updateAvailable: true, action: 'update', running: false, outcome: null });
		expect(agentCliUpdateView({ ...BEHIND, canUpdate: false }).action).toBe('manual');
		expect(agentCliUpdateView({ ...BEHIND, canUpdate: false, updateCommand: null }).action).toBe('none');
		expect(agentCliUpdateView({ ...BEHIND, advisory: 'current' }).action).toBe('none');
		expect(agentCliUpdateView({ ...BEHIND, advisory: 'unknown' }).updateAvailable).toBe(false);
	});

	it('hides actions while a run is active and reports finished runs', () => {
		const running = { ...BEHIND, run: { ...BEHIND.run, state: 'running' as const } };
		expect(agentCliUpdateView(running)).toMatchObject({ action: 'none', running: true, outcome: null });
		for (const state of ['succeeded', 'failed', 'unchanged'] as const) {
			expect(agentCliUpdateView({ ...BEHIND, run: { ...BEHIND.run, state } }).outcome).toBe(state);
		}
	});
});

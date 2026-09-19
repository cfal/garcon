import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { AgentSwitchMessage } from '$shared/chat-types';
import AgentSwitchRow from '../AgentSwitchRow.svelte';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';

vi.mock('$lib/context', () => ({
	getExecutionNodes: () => ({
		label: (id) => !id || id === 'local' ? 'Local' : id === 'worker-a' ? 'Build Machine' : id,
	} satisfies Pick<ExecutionNodesStore, 'label'>),
}));

const TS = '2026-05-14T00:00:00.000Z';

	describe('AgentSwitchRow', () => {
	it('renders the continuation boundary with resolved agent labels', () => {
		render(AgentSwitchRow, {
			message: new AgentSwitchMessage(TS, 'codex', 'claude', 'gpt-5.5', 'claude-sonnet-4-6'),
		});

		expect(screen.getByText('Continued from Codex under Claude')).toBeTruthy();
		expect(screen.getByText('(claude-sonnet-4-6)')).toBeTruthy();
		expect(screen.getByText('new agent session; earlier context is carried as history')).toBeTruthy();
	});

	it('falls back to the raw agent id for unknown agents and omits an absent model', () => {
		render(AgentSwitchRow, {
			message: new AgentSwitchMessage(TS, 'custom-agent', 'claude'),
		});

		expect(screen.getByText('Continued from custom-agent under Claude')).toBeTruthy();
		expect(screen.queryByText(/\(/)).toBeNull();
	});

	it('distinguishes the same integration on different execution nodes', () => {
		render(AgentSwitchRow, {
			message: new AgentSwitchMessage(TS, 'codex', 'codex', undefined, undefined, 'local', 'worker-a'),
		});
		expect(screen.getByText('Continued from Local / Codex under Build Machine / Codex')).toBeTruthy();
	});
});

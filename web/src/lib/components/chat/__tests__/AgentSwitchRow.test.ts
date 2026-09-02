import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { AgentSwitchMessage } from '$shared/chat-types';
import AgentSwitchRowTestHost from './AgentSwitchRowTestHost.svelte';

const TS = '2026-05-14T00:00:00.000Z';

describe('AgentSwitchRow', () => {
	it('renders the continuation boundary with resolved agent labels', () => {
		render(AgentSwitchRowTestHost, {
			message: new AgentSwitchMessage(TS, 'codex', 'claude', 'gpt-5.5', 'claude-sonnet-4-6'),
			labels: { codex: 'Catalog Codex', claude: 'Catalog Claude' },
		});

		expect(screen.getByText('Continued from Catalog Codex under Catalog Claude')).toBeTruthy();
		expect(screen.getByText('(claude-sonnet-4-6)')).toBeTruthy();
		expect(screen.getByText('new agent session; earlier context is carried as history')).toBeTruthy();
	});

	it('falls back to the raw agent id for unknown agents and omits an absent model', () => {
		render(AgentSwitchRowTestHost, {
			message: new AgentSwitchMessage(TS, 'custom-agent', 'claude'),
			labels: { claude: 'Catalog Claude' },
		});

		expect(screen.getByText('Continued from custom-agent under Catalog Claude')).toBeTruthy();
		expect(screen.queryByText(/\(/)).toBeNull();
	});
});

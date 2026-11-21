import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCliUpdateStatus } from '$shared/agent-cli-update';
import AgentCliUpdateRow from '../AgentCliUpdateRow.svelte';

const IDLE = { state: 'idle', startedAt: null, finishedAt: null, message: null, output: null } as const;
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
	run: IDLE,
};

function renderRow(status: AgentCliUpdateStatus | undefined, options: { failure?: string; starting?: boolean } = {}) {
	const onUpdate = vi.fn();
	render(AgentCliUpdateRow, { agentName: 'Codex', status, failure: options.failure, starting: options.starting, onUpdate });
	return { onUpdate };
}

describe('AgentCliUpdateRow', () => {
	it('shows the installed version and starts an available update', async () => {
		const { onUpdate } = renderRow(BEHIND);
		expect(screen.getByRole('group', { name: 'Codex CLI' }).textContent).toContain('Codex CLI');
		expect(screen.getByText('0.169.0')).toBeTruthy();
		expect(screen.getByText('Update available: 0.170.0')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Update' }));
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it('shows progress and disables the button while updating', () => {
		renderRow({ ...BEHIND, run: { ...IDLE, state: 'running', message: 'Running npm install' } });
		expect(screen.getByRole('status').textContent).toContain('Running npm install');
		expect((screen.getByRole('button', { name: 'Updating...' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('offers the manual command when Garcon cannot run the installer', () => {
		renderRow({ ...BEHIND, canUpdate: false, message: 'Version 0.170.0 is out.' });
		expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
		expect(screen.getByText(BEHIND.updateCommand!)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Copy update command' })).toBeTruthy();
		expect(screen.getByText('Version 0.170.0 is out.')).toBeTruthy();
	});

	it('reports a failed run with its output on request', async () => {
		renderRow({
			...BEHIND,
			run: { ...IDLE, state: 'failed', message: 'The update command exited with code 1: npm error EACCES', output: 'npm error EACCES' },
		});
		expect(screen.getByRole('alert').textContent).toContain('npm error EACCES');
		await fireEvent.click(screen.getByRole('button', { name: 'Show output' }));
		expect(screen.getByText('npm error EACCES', { selector: 'pre' })).toBeTruthy();
	});

	it('reports a failed status check', () => {
		renderRow(undefined, { failure: 'codex --version timed out' });
		expect(screen.getByRole('alert').textContent).toBe('CLI update check failed: codex --version timed out');
	});

	it('shows that an up-to-date CLI needs nothing', () => {
		renderRow({ ...BEHIND, advisory: 'current', latestVersion: '0.169.0' });
		expect(screen.getByText('Up to date')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
	});
});

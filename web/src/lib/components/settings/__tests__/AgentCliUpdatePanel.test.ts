import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliInstallationStatus, AgentCliUpdateResult } from '$shared/agent-installation';
import { getAgentInstallationStatus, updateAgentInstallation } from '$lib/api/agent-installation';
import AgentCliUpdatePanel from '../AgentCliUpdatePanel.svelte';
import AgentCliUpdateCardTestHost from './AgentCliUpdateCardTestHost.svelte';

vi.mock('$lib/api/agent-installation', () => ({ getAgentInstallationStatus: vi.fn(), updateAgentInstallation: vi.fn() }));
const oldVersion: AgentCliInstallationStatus = { version: '2.1.207', minimumVersion: '2.1.238', supported: false };
const newVersion: AgentCliInstallationStatus = { version: '2.1.285', minimumVersion: '2.1.238', supported: true };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

beforeEach(() => {
	vi.mocked(getAgentInstallationStatus).mockReset().mockResolvedValue(oldVersion);
	vi.mocked(updateAgentInstallation).mockReset().mockResolvedValue({ installation: newVersion, output: 'Update complete' });
});

describe('Claude Code provider settings', () => {
	it('loads lazily on expansion, including while authentication is checking', async () => {
		render(AgentCliUpdateCardTestHost, { executorId: 'remote-executor', loading: true });
		expect(getAgentInstallationStatus).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: /Claude/ }));
		await vi.waitFor(() => expect(getAgentInstallationStatus).toHaveBeenCalledWith('claude', 'remote-executor'));
		expect(await screen.findByText('Installed version: 2.1.207')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update Claude Code' })).toBeTruthy();
	});

	it('shows the minimum version and enables explicit recovery', async () => {
		render(AgentCliUpdatePanel, { agentId: 'claude', executorId: 'local', instanceId: 'instance-a' });
		expect(await screen.findByText('Claude Code 2.1.207 is unsupported. Upgrade to 2.1.238 or newer.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update Claude Code' }).hasAttribute('disabled')).toBe(false);
	});

	it('disables update and refresh while the updater runs and displays the verified version', async () => {
		const pending = deferred<AgentCliUpdateResult>();
		vi.mocked(updateAgentInstallation).mockReturnValueOnce(pending.promise);
		render(AgentCliUpdatePanel, { agentId: 'claude', executorId: 'remote-executor', instanceId: 'instance-a' });
		await screen.findByText('Installed version: 2.1.207');
		await fireEvent.click(screen.getByRole('button', { name: 'Update Claude Code' }));
		expect(screen.getByRole('button', { name: 'Updating Claude Code…' }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: 'Refresh version' }).hasAttribute('disabled')).toBe(true);
		expect(updateAgentInstallation).toHaveBeenCalledWith({ agentId: 'claude', executorId: 'remote-executor', instanceId: 'instance-a' });
		pending.resolve({ installation: newVersion, output: 'Update complete' });
		expect(await screen.findByText('Claude Code 2.1.285 is ready for new sessions.')).toBeTruthy();
		expect(screen.queryByText(/2.1.207 is unsupported/)).toBeNull();
	});

	it('keeps a package-manager no-op visibly unsupported', async () => {
		vi.mocked(updateAgentInstallation).mockResolvedValueOnce({ installation: oldVersion, output: 'Run brew upgrade claude-code' });
		render(AgentCliUpdatePanel, { agentId: 'claude', executorId: 'local', instanceId: 'instance-a' });
		await screen.findByText('Installed version: 2.1.207');
		await fireEvent.click(screen.getByRole('button', { name: 'Update Claude Code' }));
		expect(await screen.findByText(/The updater finished, but/)).toBeTruthy();
		expect(screen.getByText('Run brew upgrade claude-code')).toBeTruthy();
		expect(screen.queryByText(/is ready for new sessions/)).toBeNull();
	});

	it('shows an actionable inline failure and permits refresh', async () => {
		vi.mocked(updateAgentInstallation).mockRejectedValueOnce(new Error('Permission denied; use your package manager'));
		render(AgentCliUpdatePanel, { agentId: 'claude', executorId: 'local', instanceId: 'instance-a' });
		await screen.findByText('Installed version: 2.1.207');
		await fireEvent.click(screen.getByRole('button', { name: 'Update Claude Code' }));
		expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Permission denied; use your package manager');
		expect(screen.queryByText(/is ready for new sessions/)).toBeNull();
		vi.mocked(getAgentInstallationStatus).mockResolvedValueOnce(newVersion);
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh version' }));
		expect(await screen.findByText('Installed version: 2.1.285')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('ignores stale update results after the executor changes', async () => {
		const pending = deferred<AgentCliUpdateResult>();
		vi.mocked(updateAgentInstallation).mockReturnValueOnce(pending.promise);
		const { rerender } = render(AgentCliUpdatePanel, { agentId: 'claude', executorId: 'executor-a', instanceId: 'instance-a' });
		await screen.findByText('Installed version: 2.1.207');
		await fireEvent.click(screen.getByRole('button', { name: 'Update Claude Code' }));
		await rerender({ executorId: 'executor-b', instanceId: 'instance-b' });
		await vi.waitFor(() => expect(getAgentInstallationStatus).toHaveBeenCalledWith('claude', 'executor-b'));
		pending.resolve({ installation: newVersion, output: 'Old executor updated' });
		await vi.waitFor(() => expect(screen.getByText('Installed version: 2.1.207')).toBeTruthy());
		expect(screen.queryByText(/is ready for new sessions/)).toBeNull();
		expect(screen.queryByText('Old executor updated')).toBeNull();
	});

	it('reloads status and ignores an old reply when the same executor gets a new instance', async () => {
		const pending = deferred<AgentCliInstallationStatus>();
		vi.mocked(getAgentInstallationStatus).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(oldVersion);
		const { rerender } = render(AgentCliUpdatePanel, {
			agentId: 'claude',
			executorId: 'remote-executor',
			instanceId: 'instance-a',
		});
		await vi.waitFor(() => expect(getAgentInstallationStatus).toHaveBeenCalledTimes(1));
		await rerender({ instanceId: 'instance-b' });
		await vi.waitFor(() => expect(getAgentInstallationStatus).toHaveBeenCalledTimes(2));
		await screen.findByText('Installed version: 2.1.207');
		pending.resolve(newVersion);
		await pending.promise;
		await tick();
		expect(screen.getByText('Installed version: 2.1.207')).toBeTruthy();
		expect(screen.queryByText('Installed version: 2.1.285')).toBeNull();
	});

	it('clears a pending update and ignores its result when the same executor gets a new instance', async () => {
		const pending = deferred<AgentCliUpdateResult>();
		vi.mocked(updateAgentInstallation).mockReturnValueOnce(pending.promise);
		const { rerender } = render(AgentCliUpdatePanel, {
			agentId: 'claude',
			executorId: 'remote-executor',
			instanceId: 'instance-a',
		});
		await screen.findByText('Installed version: 2.1.207');
		await fireEvent.click(screen.getByRole('button', { name: 'Update Claude Code' }));
		expect(updateAgentInstallation).toHaveBeenCalledWith({ agentId: 'claude', executorId: 'remote-executor', instanceId: 'instance-a' });
		await rerender({ instanceId: 'instance-b' });
		await vi.waitFor(() => expect(getAgentInstallationStatus).toHaveBeenCalledTimes(2));
		await screen.findByText('Installed version: 2.1.207');
		expect(screen.getByRole('button', { name: 'Update Claude Code' }).hasAttribute('disabled')).toBe(false);
		pending.resolve({ installation: newVersion, output: 'Old instance updated' });
		await pending.promise;
		await tick();
		expect(screen.getByText('Installed version: 2.1.207')).toBeTruthy();
		expect(screen.queryByText(/is ready for new sessions/)).toBeNull();
		expect(screen.queryByText('Old instance updated')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Update Claude Code' }));
		expect(updateAgentInstallation).toHaveBeenLastCalledWith({ agentId: 'claude', executorId: 'remote-executor', instanceId: 'instance-b' });
	});
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/execution-nodes';
import { copyToClipboard } from '$lib/utils/clipboard';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';
import ExecutionNodesDialogTestHost from './ExecutionNodesDialogTestHost.svelte';

vi.mock('$lib/api/execution-nodes', () => ({
	getExecutionNodes: vi.fn(), createExecutionNode: vi.fn(), updateExecutionNode: vi.fn(),
	removeExecutionNode: vi.fn(), getExecutionNodeConnection: vi.fn(),
}));
vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }));

const connection = {
	connectionUrl: `wss://example.test/execution-node/${remoteExecutionNode.id}#secret=${'A'.repeat(43)}`,
	allowInsecureDevelopment: false,
	allowUnverifiedTls: false,
};

async function openDialog() {
	render(ExecutionNodesDialogTestHost);
	const opener = screen.getByRole('button', { name: 'Open execution nodes' });
	opener.focus();
	await fireEvent.click(opener);
	await screen.findByText('Local');
	return opener;
}

describe('ExecutionNodesDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.getExecutionNodes).mockResolvedValue([localExecutionNode]);
		vi.mocked(api.createExecutionNode).mockImplementation(async () => {
			vi.mocked(api.getExecutionNodes).mockResolvedValue([localExecutionNode, remoteExecutionNode]);
			return { id: remoteExecutionNode.id, ...connection };
		});
		vi.mocked(api.getExecutionNodeConnection).mockResolvedValue(connection);
	});

	it('creates an inbound node, copies the explicit credential and clears it on close', async () => {
		const opener = await openDialog();
		expect(screen.queryByRole('button', { name: 'Edit Local' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Add Node' }));
		const label = screen.getByLabelText('Label');
		expect(screen.getByRole('button', { name: 'Add Node' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.input(label, { target: { value: 'Build Machine' } });
		await fireEvent.submit(label.closest('form')!);
		const url = await screen.findByLabelText('Connection URL') as HTMLInputElement;
		expect(url.value).toBe(connection.connectionUrl);
		expect(url.type).toBe('text');
		expect(api.createExecutionNode).toHaveBeenCalledWith({ label: 'Build Machine', direction: 'node-connects', allowInsecureDevelopment: false, allowUnverifiedTls: false });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy connection URL' }));
		expect(copyToClipboard).toHaveBeenCalledWith(connection.connectionUrl, expect.any(HTMLElement), expect.any(Function));
		await fireEvent.keyDown(url, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(opener);
		await fireEvent.click(opener);
		await fireEvent.click(await screen.findByRole('button', { name: 'Add Node' }));
		expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('');
		expect(screen.queryByLabelText('Connection URL')).toBeNull();
	});

	it('accepts a pasted outbound descriptor and presents configuration errors inline', async () => {
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Add Node' }));
		await fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'Worker' } });
		const direction = screen.getByLabelText('Connection direction') as HTMLSelectElement;
		direction.options[1].selected = true;
		// Happy DOM does not match selected options through :checked, which Svelte's binding reads.
		const selectedOption = vi.spyOn(direction, 'querySelector').mockReturnValueOnce(direction.options[1]);
		await fireEvent.change(direction);
		selectedOption.mockRestore();
		const url = screen.getByLabelText('Connection URL');
		const descriptor = `ws://worker.test:19781/execution-node#secret=${'A'.repeat(43)}`;
		await fireEvent.input(url, { target: { value: descriptor } });
		await fireEvent.click(screen.getByLabelText('Allow connection without TLS (ws://)'));
		expect(screen.getByText(/TLS is disabled/).classList.contains('text-destructive')).toBe(true);
		expect(url.getAttribute('aria-describedby')).toBe('execution-node-tls-warning');
		vi.mocked(api.createExecutionNode).mockRejectedValueOnce(new Error('Invalid connection address'));
		await fireEvent.submit(url.closest('form')!);
		expect((await screen.findByText('Invalid connection address')).getAttribute('role')).toBe('alert');
		expect(api.createExecutionNode).toHaveBeenCalledWith({ label: 'Worker', direction: 'controller-connects', connectionUrl: descriptor, allowInsecureDevelopment: true, allowUnverifiedTls: false });
		expect((url as HTMLInputElement).value).toBe(descriptor);
	});

	it('keeps saved credentials readable without a reveal control', async () => {
		vi.mocked(api.getExecutionNodes).mockResolvedValue([localExecutionNode, remoteExecutionNode]);
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker' }));
		const url = screen.getByLabelText('Connection URL') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe(connection.connectionUrl));
		expect(url.type).toBe('text');
		expect(screen.queryByRole('button', { name: 'Reveal URL' })).toBeNull();
		expect(screen.queryByText(/TLS is disabled/)).toBeNull();
		expect(screen.queryByLabelText('Allow unverified TLS certificates')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Back to nodes' }));
		expect(screen.queryByLabelText('Connection URL')).toBeNull();
	});

	it('defaults to certificate verification and saves an explicit outbound opt-out', async () => {
		vi.mocked(api.getExecutionNodes).mockResolvedValue([localExecutionNode, { ...remoteExecutionNode, direction: 'controller-connects' }]);
		vi.mocked(api.updateExecutionNode).mockResolvedValue([localExecutionNode, remoteExecutionNode]);
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker' }));
		const url = screen.getByLabelText('Connection URL') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe(connection.connectionUrl));
		const optOut = screen.getByLabelText('Allow unverified TLS certificates') as HTMLInputElement;
		expect(optOut.checked).toBe(false);
		await fireEvent.click(optOut);
		expect(screen.getByText(/TLS certificate verification is disabled/).textContent).toContain('Noise still authenticates');
		await fireEvent.submit(url.closest('form')!);
		await waitFor(() => expect(api.updateExecutionNode).toHaveBeenCalledWith(remoteExecutionNode.id, {
			label: 'Worker',
			connection: { direction: 'controller-connects', connectionUrl: connection.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true },
		}));
	});
});

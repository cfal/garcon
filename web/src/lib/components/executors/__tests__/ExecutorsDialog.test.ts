import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/executors';
import { copyToClipboard } from '$lib/utils/clipboard';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import ExecutorsDialogTestHost from './ExecutorsDialogTestHost.svelte';

vi.mock('$lib/api/executors', () => ({
	getExecutors: vi.fn(), createExecutor: vi.fn(), updateExecutor: vi.fn(),
	removeExecutor: vi.fn(), getExecutorConnection: vi.fn(),
}));
vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }));

const connection = {
	connectionUrl: `wss://example.test/executor/${remoteExecutor.id}#secret=${'A'.repeat(43)}`,
	allowInsecureDevelopment: false,
	allowUnverifiedTls: false,
};

async function openDialog() {
	render(ExecutorsDialogTestHost);
	const opener = screen.getByRole('button', { name: 'Open executors' });
	opener.focus();
	await fireEvent.click(opener);
	await screen.findByText('Local');
	return opener;
}

describe('ExecutorsDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.getExecutors).mockResolvedValue([localExecutor]);
		vi.mocked(api.createExecutor).mockImplementation(async () => {
			vi.mocked(api.getExecutors).mockResolvedValue([localExecutor, remoteExecutor]);
			return { id: remoteExecutor.id, ...connection };
		});
		vi.mocked(api.getExecutorConnection).mockResolvedValue(connection);
	});

	it('creates an inbound executor, copies the explicit credential and clears it on close', async () => {
		const opener = await openDialog();
		expect(screen.queryByRole('button', { name: 'Edit Local' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Add Executor' }));
		const label = screen.getByLabelText('Label');
		expect(screen.getByRole('button', { name: 'Add Executor' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.input(label, { target: { value: 'Build Machine' } });
		await fireEvent.submit(label.closest('form')!);
		const url = await screen.findByLabelText('Connection URL') as HTMLInputElement;
		expect(url.value).toBe(connection.connectionUrl);
		expect(url.type).toBe('text');
		expect(api.createExecutor).toHaveBeenCalledWith({ label: 'Build Machine', direction: 'executor-connects', allowInsecureDevelopment: false, allowUnverifiedTls: false, allowControllerCli: false });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy connection URL' }));
		expect(copyToClipboard).toHaveBeenCalledWith(connection.connectionUrl, expect.any(HTMLElement), expect.any(Function));
		await fireEvent.keyDown(url, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(opener);
		await fireEvent.click(opener);
		await fireEvent.click(await screen.findByRole('button', { name: 'Add Executor' }));
		expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('');
		expect(screen.queryByLabelText('Connection URL')).toBeNull();
	});

	it('accepts a pasted outbound descriptor and presents configuration errors inline', async () => {
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Add Executor' }));
		await fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'Worker' } });
		const direction = screen.getByLabelText('Connection direction') as HTMLSelectElement;
		direction.options[1].selected = true;
		// Happy DOM does not match selected options through :checked, which Svelte's binding reads.
		const selectedOption = vi.spyOn(direction, 'querySelector').mockReturnValueOnce(direction.options[1]);
		await fireEvent.change(direction);
		selectedOption.mockRestore();
		const url = screen.getByLabelText('Connection URL');
		const descriptor = `ws://worker.test:19781/executor#secret=${'A'.repeat(43)}`;
		await fireEvent.input(url, { target: { value: descriptor } });
		await fireEvent.click(screen.getByLabelText('Allow connection without TLS (ws://)'));
		expect(screen.getByText(/TLS is disabled/).classList.contains('text-destructive')).toBe(true);
		expect(url.getAttribute('aria-describedby')).toBe('executor-tls-warning');
		vi.mocked(api.createExecutor).mockRejectedValueOnce(new Error('Invalid connection address'));
		await fireEvent.submit(url.closest('form')!);
		expect((await screen.findByText('Invalid connection address')).getAttribute('role')).toBe('alert');
		expect(api.createExecutor).toHaveBeenCalledWith({ label: 'Worker', direction: 'controller-connects', connectionUrl: descriptor, allowInsecureDevelopment: true, allowUnverifiedTls: false, allowControllerCli: false });
		expect((url as HTMLInputElement).value).toBe(descriptor);
	});

	it('keeps saved credentials readable without a reveal control', async () => {
		vi.mocked(api.getExecutors).mockResolvedValue([localExecutor, remoteExecutor]);
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker' }));
		const url = screen.getByLabelText('Connection URL') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe(connection.connectionUrl));
		expect(url.type).toBe('text');
		expect(screen.queryByRole('button', { name: 'Reveal URL' })).toBeNull();
		expect(screen.queryByText(/TLS is disabled/)).toBeNull();
		expect(screen.queryByLabelText('Allow unverified TLS certificates')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Back to executors' }));
		expect(screen.queryByLabelText('Connection URL')).toBeNull();
	});

	it('confirms deletion without saving edits, retains conflicts, then returns to the executor list', async () => {
		vi.mocked(api.getExecutors).mockResolvedValue([localExecutor, remoteExecutor]);
		vi.mocked(api.removeExecutor).mockRejectedValueOnce(new Error('Stop or finish this executor\'s active work before changing its connection.'));
		vi.mocked(api.removeExecutor).mockResolvedValueOnce([localExecutor]);
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Delete executor' }).hasAttribute('disabled')).toBe(false));
		await fireEvent.click(screen.getByRole('button', { name: 'Delete executor' }));
		expect(screen.getByText(/Chats and saved settings will remain/)).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
		await fireEvent.submit(screen.getByLabelText('Label').closest('form')!);
		expect(api.updateExecutor).not.toHaveBeenCalled();
		expect(api.removeExecutor).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText(/Chats and saved settings will remain/)).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Delete executor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Delete Executor' }));
		expect((await screen.findByRole('alert')).textContent).toContain('Stop or finish');
		await fireEvent.click(screen.getByRole('button', { name: 'Delete Executor' }));
		await waitFor(() => expect(screen.queryByLabelText('Connection URL')).toBeNull());
		expect(api.removeExecutor).toHaveBeenLastCalledWith(remoteExecutor.id);
		expect(screen.queryByRole('button', { name: 'Edit Worker' })).toBeNull();
		expect(screen.getByText('Local')).toBeDefined();
	});

	it('defaults to certificate verification and saves an explicit outbound opt-out', async () => {
		vi.mocked(api.getExecutors).mockResolvedValue([localExecutor, { ...remoteExecutor, direction: 'controller-connects' }]);
		vi.mocked(api.updateExecutor).mockResolvedValue([localExecutor, remoteExecutor]);
		await openDialog();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker' }));
		const url = screen.getByLabelText('Connection URL') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe(connection.connectionUrl));
		const optOut = screen.getByLabelText('Allow unverified TLS certificates') as HTMLInputElement;
		expect(optOut.checked).toBe(false);
		await fireEvent.click(optOut);
		expect(screen.getByText(/TLS certificate verification is disabled/).textContent).toContain('Noise still authenticates');
		await fireEvent.submit(url.closest('form')!);
		await waitFor(() => expect(api.updateExecutor).toHaveBeenCalledWith(remoteExecutor.id, {
			label: 'Worker',
			connection: { direction: 'controller-connects', connectionUrl: connection.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true },
		}));
	});
});

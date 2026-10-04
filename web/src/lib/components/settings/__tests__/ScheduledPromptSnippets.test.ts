import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpandSnippetResponse, Snippet } from '$shared/snippets';
import { expandSnippet } from '$lib/api/snippets';
import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte';
import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte';
import ScheduledPromptSnippetsTestHost from './ScheduledPromptSnippetsTestHost.svelte';

vi.mock('$lib/api/snippets', () => ({ expandSnippet: vi.fn() }));
const expand = vi.mocked(expandSnippet);
const snippet: Snippet = {
	id: 'review',
	shortName: 'review',
	template: 'Review {{arguments}}',
	defaultArguments: 'API',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};
const response: ExpandSnippetResponse = {
	success: true,
	source: 'snippet',
	sourceId: snippet.id,
	sourceUpdatedAt: snippet.updatedAt,
	shortName: snippet.shortName,
	contextProjectPath: '/repo',
	contextExecutorId: 'local',
	expandedText: 'Review API',
};

function renderEditor() {
	const getSnippets = vi.fn(async () => ({ revision: 1, snippets: [snippet] }));
	const getPreambles = vi.fn(async () => ({ revision: 0, preambles: [] }));
	const snippets = createSnippetsStore({ get: getSnippets });
	const preambles = createPreamblesStore({ get: getPreambles });
	render(ScheduledPromptSnippetsTestHost, { snippets, preambles });
	return { snippets, getSnippets, getPreambles };
}

async function openArguments() {
	const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
	prompt.setSelectionRange(prompt.value.length, prompt.value.length);
	await fireEvent.click(screen.getByRole('button', { name: 'Insert Snippet' }));
	await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
	return screen.findByRole('dialog', { name: 'Arguments for /snippet review' });
}

beforeEach(() => expand.mockReset());
afterEach(cleanup);

describe('scheduled prompt snippet interactions', () => {
	it('closes stale arguments and refreshes the changed catalog after a delayed expansion', async () => {
		const { snippets, getSnippets, getPreambles } = renderEditor();
		let resolve!: (value: ExpandSnippetResponse) => void;
		expand.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
		await openArguments();
		await fireEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));
		await waitFor(() => expect(expand).toHaveBeenCalledOnce());

		const updated = {
			...snippet,
			updatedAt: '2026-01-02T00:00:00.000Z',
			defaultArguments: 'updated',
		};
		getSnippets.mockResolvedValue({ revision: 2, snippets: [updated] });
		snippets.applySnapshot({ revision: 2, snippets: [updated] });
		resolve({ ...response, sourceUpdatedAt: updated.updatedAt });

		await screen.findByText(/That snippet changed/);
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByTestId('prompt-draft').textContent).toBe('Before ');
		await waitFor(() => expect(getSnippets).toHaveBeenCalledTimes(2));
		expect(getPreambles).toHaveBeenCalledOnce();

		await openArguments();
		expect((screen.getByRole('textbox', { name: 'Arguments' }) as HTMLTextAreaElement).value).toBe(
			'updated',
		);
		expand.mockResolvedValueOnce({ ...response, sourceUpdatedAt: updated.updatedAt });
		await fireEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));
		await waitFor(() =>
			expect(screen.getByTestId('prompt-draft').textContent).toBe('Before Review API'),
		);
	});

	it('shows retryable expansion failures inside the reopened arguments dialog and preserves edits', async () => {
		renderEditor();
		expand.mockRejectedValueOnce(new Error('Path unavailable'));
		await openArguments();
		await fireEvent.input(screen.getByRole('textbox', { name: 'Arguments' }), {
			target: { value: 'edited arguments' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));

		const dialog = await screen.findByRole('dialog', { name: 'Arguments for /snippet review' });
		expect(within(dialog).getByRole('alert').textContent).toBe('Path unavailable');
		expect(
			(within(dialog).getByRole('textbox', { name: 'Arguments' }) as HTMLTextAreaElement).value,
		).toBe('edited arguments');
		expect(screen.getByTestId('prompt-draft').textContent).toBe('Before ');
	});

	it('updates and resizes composing input without opening the snippet picker', async () => {
		renderEditor();
		const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
		Object.defineProperty(prompt, 'scrollHeight', { configurable: true, value: 96 });
		prompt.value = 'Before ;;';
		prompt.setSelectionRange(prompt.value.length, prompt.value.length);
		await fireEvent(prompt, new InputEvent('input', { bubbles: true, isComposing: true }));

		expect(screen.getByTestId('prompt-draft').textContent).toBe('Before ;;');
		expect(prompt.style.height).toBe('96px');
		expect(screen.queryByRole('dialog')).toBeNull();

		await fireEvent(prompt, new InputEvent('input', { bubbles: true, isComposing: false }));
		expect(await screen.findByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
	});
});

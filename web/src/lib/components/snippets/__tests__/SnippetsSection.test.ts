import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SnippetsSectionTestHost from './SnippetsSectionTestHost.svelte';

describe('SnippetsSection', () => {
	afterEach(cleanup);

	it('adds and edits multiline snippets without normalizing names or text', async () => {
		render(SnippetsSectionTestHost);
		const add = await screen.findByRole('button', { name: 'Add snippet' });
		await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(add);

		const name = screen.getByRole('textbox', { name: 'Short name' }) as HTMLInputElement;
		const template = screen.getByRole('textbox', { name: 'Snippet text' });
		const save = screen.getByRole('button', { name: 'Save' });
		await fireEvent.input(name, { target: { value: ' Review' } });
		await fireEvent.input(template, { target: { value: '\nReview {{arguments}}\n' } });
		expect(name.value).toBe(' Review');
		expect((save as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/Use only lowercase letters/)).toBeTruthy();

		await fireEvent.input(name, { target: { value: 'review_api-2' } });
		await fireEvent.click(save);

		expect(await screen.findByText('/snippet review_api-2')).toBeTruthy();
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull(),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Edit review_api-2' }));
		expect(
			(screen.getByRole('textbox', { name: 'Snippet text' }) as HTMLTextAreaElement).value,
		).toBe('\nReview {{arguments}}\n');
		await fireEvent.input(screen.getByRole('textbox', { name: 'Snippet text' }), {
			target: { value: '\nUpdated {{arguments}}\n' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Edit Snippet' })).toBeNull(),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Edit review_api-2' }));
		expect(
			(screen.getByRole('textbox', { name: 'Snippet text' }) as HTMLTextAreaElement).value,
		).toBe('\nUpdated {{arguments}}\n');
	});

	it('enforces order boundaries, moves rows, and confirms removal', async () => {
		render(SnippetsSectionTestHost);
		await screen.findByText('/snippet review');
		expect(
			(screen.getByRole('button', { name: 'Move review up' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Move summarize down' }) as HTMLButtonElement).disabled,
		).toBe(true);

		await fireEvent.click(screen.getByRole('button', { name: 'Move summarize up' }));
		await waitFor(() => {
			const rows = screen.getAllByRole('heading', { level: 3 }).map((row) => row.textContent);
			expect(rows).toEqual(['/snippet summarize', '/snippet review']);
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Remove summarize' }));
		expect(
			(await screen.findByRole('dialog', { name: 'Remove Snippet' })).textContent,
		).toContain('Remove /snippet summarize?');
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.getByText('/snippet summarize')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Remove summarize' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		await waitFor(() => expect(screen.queryByText('/snippet summarize')).toBeNull());
	});
});

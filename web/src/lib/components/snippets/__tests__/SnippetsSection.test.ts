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
		const defaultArguments = screen.getByRole('textbox', {
			name: 'Default arguments (optional)',
		});
		const save = screen.getByRole('button', { name: 'Save' });
		expect(
			screen.getByText(
				'Use /snippet <short-name> [arguments] or /s <short-name> [arguments]. Names use lowercase letters, numbers, _, or -; maximum 64 characters.',
			),
		).toBeTruthy();
		await fireEvent.input(name, { target: { value: ' Review' } });
		await fireEvent.input(template, { target: { value: '\nReview {{arguments}}\n' } });
		expect(name.value).toBe(' Review');
		expect((save as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/Use only lowercase letters/)).toBeTruthy();

		await fireEvent.input(name, { target: { value: 'review_api-2' } });
		await fireEvent.input(defaultArguments, {
			target: { value: '\n staged changes \nsecond line ' },
		});
		await fireEvent.click(save);

		expect(await screen.findByText('review_api-2')).toBeTruthy();
		expect(screen.getByText('Default:')).toBeTruthy();
		expect(screen.getByText(/staged changes/)).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
		await fireEvent.click(screen.getByRole('button', { name: 'Edit review_api-2' }));
		expect(
			(screen.getByRole('textbox', { name: 'Snippet text' }) as HTMLTextAreaElement).value,
		).toBe('\nReview {{arguments}}\n');
		expect(
			(
				screen.getByRole('textbox', {
					name: 'Default arguments (optional)',
				}) as HTMLTextAreaElement
			).value,
		).toBe('\n staged changes \nsecond line ');
		await fireEvent.input(screen.getByRole('textbox', { name: 'Snippet text' }), {
			target: { value: '\nUpdated {{arguments}}\n' },
		});
		await fireEvent.input(screen.getByRole('textbox', { name: 'Default arguments (optional)' }), {
			target: { value: '' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Snippet' })).toBeNull());
		await fireEvent.click(screen.getByRole('button', { name: 'Edit review_api-2' }));
		expect(
			(screen.getByRole('textbox', { name: 'Snippet text' }) as HTMLTextAreaElement).value,
		).toBe('\nUpdated {{arguments}}\n');
		expect(
			(
				screen.getByRole('textbox', {
					name: 'Default arguments (optional)',
				}) as HTMLTextAreaElement
			).value,
		).toBe('');
		expect(screen.queryByText('Default:')).toBeNull();
	});

	it('preserves an invalid default until its arguments token is restored', async () => {
		render(SnippetsSectionTestHost);
		await fireEvent.click(await screen.findByRole('button', { name: 'Add snippet' }));
		await fireEvent.input(screen.getByRole('textbox', { name: 'Short name' }), {
			target: { value: 'review_api' },
		});
		const template = screen.getByRole('textbox', { name: 'Snippet text' });
		const defaultArguments = screen.getByRole('textbox', {
			name: 'Default arguments (optional)',
		}) as HTMLTextAreaElement;
		const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		await fireEvent.input(template, { target: { value: 'Review this' } });
		await fireEvent.input(defaultArguments, { target: { value: 'staged changes' } });

		expect(
			screen.getByText('Add {{arguments}} to the snippet text or clear the default.'),
		).toBeTruthy();
		expect(defaultArguments.value).toBe('staged changes');
		expect(save.disabled).toBe(true);

		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
		expect(
			screen.queryByText('Add {{arguments}} to the snippet text or clear the default.'),
		).toBeNull();
		expect(defaultArguments.value).toBe('staged changes');
		expect(save.disabled).toBe(false);
	});

	it('enforces the default limit and saves from either multiline field shortcut', async () => {
		render(SnippetsSectionTestHost);
		await fireEvent.click(await screen.findByRole('button', { name: 'Add snippet' }));
		await fireEvent.input(screen.getByRole('textbox', { name: 'Short name' }), {
			target: { value: 'review_api' },
		});
		const template = screen.getByRole('textbox', { name: 'Snippet text' });
		const defaultArguments = screen.getByRole('textbox', {
			name: 'Default arguments (optional)',
		}) as HTMLTextAreaElement;
		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
		await fireEvent.input(defaultArguments, { target: { value: 'x'.repeat(32_001) } });
		expect(screen.getByText('Default arguments cannot exceed 32,000 characters.')).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

		await fireEvent.input(defaultArguments, { target: { value: 'staged changes' } });
		await fireEvent.keyDown(defaultArguments, { key: 'Enter' });
		expect(defaultArguments.value).toBe('staged changes');
		await fireEvent.keyDown(defaultArguments, { key: 'Enter', ctrlKey: true });
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
		expect(await screen.findByText('review_api')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Edit review_api' }));
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Snippet text' }), {
			key: 'Enter',
			metaKey: true,
		});
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Snippet' })).toBeNull());
	});

	it('closes the form through every cancel path and restores focus', async () => {
		render(SnippetsSectionTestHost);
		const add = await screen.findByRole('button', { name: 'Add snippet' });
		await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
		add.focus();
		await fireEvent.click(add);

		const dialog = await screen.findByRole('dialog', { name: 'Add Snippet' });
		expect(dialog.className).toContain('var(--app-viewport-center-y)');
		expect(dialog.className).toContain('var(--app-height)');
		expect(dialog.className).toContain('overflow-hidden');
		expect(dialog.querySelector('.overflow-y-auto')).toBeTruthy();
		await fireEvent.input(screen.getByRole('textbox', { name: 'Short name' }), {
			target: { value: 'unfinished' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(add));

		await fireEvent.click(add);
		await fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Add Snippet' }), {
			key: 'Escape',
		});
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(add));

		await fireEvent.click(add);
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
	});

	it('renders sorted rows without move controls and confirms removal', async () => {
		render(SnippetsSectionTestHost);
		await screen.findByText('review');
		const rows = screen.getAllByRole('heading', { level: 3 }).map((row) => row.textContent);
		expect(rows).toEqual(['review', 'summarize']);
		expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Remove summarize' }));
		expect((await screen.findByRole('dialog', { name: 'Remove Snippet' })).textContent).toContain(
			'Remove /snippet summarize?',
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.getByText('summarize')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Remove summarize' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		await waitFor(() => expect(screen.queryByText('summarize')).toBeNull());
	});

	it('disables remove confirmation while snippets refresh', async () => {
		render(SnippetsSectionTestHost, { blockRefresh: true });
		await screen.findByText('review');
		await fireEvent.click(screen.getByRole('button', { name: 'Remove review' }));
		await fireEvent.click(screen.getByTestId('begin-refresh'));

		const confirm = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement;
		await waitFor(() => expect(confirm.disabled).toBe(true));
		await fireEvent.click(screen.getByTestId('release-refresh'));
		await waitFor(() => expect(confirm.disabled).toBe(false));
	});

	it('keeps the form dialog controlled while a save is pending', async () => {
		render(SnippetsSectionTestHost, { blockSave: true });
		await fireEvent.click(await screen.findByRole('button', { name: 'Add snippet' }));
		await fireEvent.input(screen.getByRole('textbox', { name: 'Short name' }), {
			target: { value: 'review_api' },
		});
		await fireEvent.input(screen.getByRole('textbox', { name: 'Snippet text' }), {
			target: { value: 'Review {{arguments}}' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		const dialog = screen.getByRole('dialog', { name: 'Add Snippet' });
		await screen.findByRole('button', { name: 'Saving...' });
		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(dialog.isConnected).toBe(true);

		await fireEvent.click(screen.getByTestId('reject-save'));
		expect(await screen.findByText(/save failed/)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
	});
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ComposerSnippetPaletteTestHost from './ComposerSnippetPaletteTestHost.svelte';

describe('ComposerSnippetPalette', () => {
	afterEach(cleanup);

	it('loads snippets when opened', async () => {
		render(ComposerSnippetPaletteTestHost);

		await screen.findByText('item-11');

		expect(screen.getByTestId('load-count').textContent).toBe('1');
	});

	it('prefills the search from the captured trigger query', async () => {
		render(ComposerSnippetPaletteTestHost, { initialQuery: 'summarize' });

		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		expect(search.value).toBe('summarize');
		const names = screen.getAllByText(/^item-/).map((entry) => entry.textContent);
		expect(names).toEqual(['item-1', 'item-3', 'item-5', 'item-7', 'item-9', 'item-11']);
	});

	it('ranks short-name matches ahead of template matches', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = await screen.findByRole('combobox', { name: 'Search snippets' });

		await fireEvent.input(search, { target: { value: 'item-7' } });

		const options = screen.getAllByRole('option');
		expect(options[0]?.textContent).toContain('item-7');

		await fireEvent.input(search, { target: { value: 'review' } });
		const templateMatches = screen.getAllByRole('option').map((option) => option.textContent);
		expect(templateMatches.length).toBe(6);
		expect(templateMatches[0]).toContain('item-0');
	});

	it('moves the highlight with arrow keys and tracks aria-activedescendant', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		search.focus();
		const firstOption = screen.getByRole('option', { name: /^item-0\b/ });
		expect(search.getAttribute('aria-activedescendant')).toBe(firstOption.id);

		await fireEvent.keyDown(search, { key: 'ArrowDown' });
		const secondOption = screen.getByRole('option', { name: /^item-1\b/ });
		expect(search.getAttribute('aria-activedescendant')).toBe(secondOption.id);
		expect(secondOption.getAttribute('aria-selected')).toBe('true');

		await fireEvent.keyDown(search, { key: 'ArrowUp' });
		expect(search.getAttribute('aria-activedescendant')).toBe(firstOption.id);

		await fireEvent.keyDown(search, { key: 'End' });
		expect(search.getAttribute('aria-activedescendant')).toBe(
			screen.getByRole('option', { name: /^item-11\b/ }).id,
		);
		await fireEvent.keyDown(search, { key: 'Home' });
		expect(search.getAttribute('aria-activedescendant')).toBe(firstOption.id);
	});

	it('inserts the highlighted snippet with Enter and closes', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		search.focus();
		await fireEvent.keyDown(search, { key: 'ArrowDown' });

		await fireEvent.keyDown(search, { key: 'Enter' });

		await waitFor(() => expect(screen.getByTestId('palette-open').textContent).toBe('false'));
		expect(screen.getByTestId('selected-snippet').textContent).toBe('item-1');
		expect(screen.getByTestId('cancel-count').textContent).toBe('0');
	});

	it('does not insert while the search input is composing', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = await screen.findByRole('combobox', { name: 'Search snippets' });

		await fireEvent.keyDown(search, { key: 'Enter', isComposing: true });

		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		expect(screen.getByTestId('palette-open').textContent).toBe('true');
	});

	it('does not insert with Tab so the modal focus trap stays reachable', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		search.focus();

		await fireEvent.keyDown(search, { key: 'Tab' });

		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		expect(screen.getByTestId('palette-open').textContent).toBe('true');
	});

	it('resets the highlight when the query changes', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		search.focus();
		await fireEvent.keyDown(search, { key: 'ArrowDown' });

		await fireEvent.input(search, { target: { value: 'item-0' } });

		expect(search.getAttribute('aria-activedescendant')).toBe(
			screen.getByRole('option', { name: /^item-0\b/ }).id,
		);
	});

	it('keeps the highlighted snippet across a snapshot refresh', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = await screen.findByRole('combobox', { name: 'Search snippets' });
		await fireEvent.keyDown(search, { key: 'ArrowDown' });
		const highlighted = screen.getByRole('option', { name: /^item-1\b/ });

		await fireEvent.click(screen.getByTestId('refresh-snapshot'));

		expect(search.getAttribute('aria-activedescendant')).toBe(highlighted.id);
		expect(highlighted.getAttribute('aria-selected')).toBe('true');
	});

	it('shows the highlighted template in the preview strip', async () => {
		render(ComposerSnippetPaletteTestHost);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		search.focus();

		const preview = screen.getByRole('region', { name: 'Template preview' });
		expect(preview.textContent).toContain('Review item 0');
		expect(preview.getAttribute('tabindex')).toBe('0');

		await fireEvent.keyDown(search, { key: 'ArrowDown' });
		expect(preview.textContent).toContain('Summarize item 1');
	});

	it('hides the preview while the mobile keyboard needs the palette height', async () => {
		render(ComposerSnippetPaletteTestHost, { mobile: true, keyboardHeight: 320 });

		await screen.findByRole('option', { name: /^item-0\b/ });
		expect(screen.queryByRole('region', { name: 'Template preview' })).toBeNull();
	});

	it('badges templates that use the supported tokens', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Chat {{chat_id}}: review {{arguments}} in {{project_path}}',
		});

		await screen.findByRole('option', { name: /item-0/ });

		expect(screen.getByLabelText('Uses the {{arguments}} placeholder').textContent).toBe(
			'{{arguments}}',
		);
		expect(screen.getByLabelText('Uses the {{project_path}} placeholder').textContent).toBe(
			'{{project_path}}',
		);
		expect(screen.getByLabelText('Uses the {{chat_id}} placeholder').textContent).toBe(
			'{{chat_id}}',
		);
	});

	it('collects arguments before inserting a snippet that uses them', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}} in {{project_path}}',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));

		const input = await screen.findByRole('textbox', { name: 'Arguments' });
		const rawArguments = '\n  the API boundaries  \nsecond line\n';
		await fireEvent.input(input, { target: { value: rawArguments } });
		await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
		await fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		expect(screen.getByRole('dialog', { name: 'Arguments for /snippet item-0' })).toBeTruthy();
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		expect((input as HTMLTextAreaElement).value).toBe(rawArguments);
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Arguments for /snippet item-0' })).toBeNull(),
		);
		expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0');
		expect(screen.getByTestId('selected-arguments').textContent).toBe(rawArguments);
	});

	it('prefills saved defaults and selects them for replacement', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
			firstDefaultArguments: 'staged changes',
		});
		const composer = screen.getByRole('textbox', { name: 'Composer prompt' });
		const option = await screen.findByRole('option', { name: /item-0/ });
		expect(screen.getByTestId('main-inert').textContent).toBe('true');
		option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(screen.getByTestId('main-inert').textContent).toBe('false');
		expect(document.activeElement).toBe(composer);

		const input = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(screen.getByTestId('main-inert').textContent).toBe('true');
		expect(input.value).toBe('staged changes');
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe(input.value.length);

		const insert = screen.getByRole('button', { name: 'Insert snippet' });
		insert.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(screen.getByTestId('main-inert').textContent).toBe('false');
		expect(document.activeElement).toBe(composer);
		await waitFor(() => expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0'));
		expect(screen.getByTestId('selected-arguments').textContent).toBe('staged changes');
	});

	it('clears a prefill without losing focus and inserts explicit empty', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
			firstDefaultArguments: 'staged changes',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));
		const input = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		const clear = screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement;

		await fireEvent.click(clear);
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.value).toBe('');
		expect(input.selectionStart).toBe(0);
		expect(clear.disabled).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));

		await waitFor(() => expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0'));
		expect(screen.getByTestId('selected-arguments').textContent).toBe('');
	});

	it('does not replace an edited draft when the snippet snapshot refreshes', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
			firstDefaultArguments: 'saved default',
			refreshedDefaultArguments: 'new server default',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));
		const input = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: 'edited draft' } });

		await fireEvent.click(screen.getByTestId('refresh-snapshot'));

		expect(input.value).toBe('edited draft');
	});

	it('keeps over-limit arguments visible and prevents insertion', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));

		const input = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		const overLimit = 'x'.repeat(32_001);
		await fireEvent.input(input, { target: { value: overLimit } });

		expect(input.value).toBe(overLimit);
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(screen.getByText('Arguments cannot exceed 32,000 characters.')).toBeTruthy();
		expect(
			(screen.getByRole('button', { name: 'Insert snippet' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
	});

	it('does not prompt for an escaped arguments marker', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Keep \\{{arguments}} literal',
		});

		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));

		await waitFor(() => expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0'));
		expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull();
		expect(screen.getByTestId('selected-arguments').textContent).toBe('');
	});

	it('preserves arguments and reopens the dialog after expansion failure', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
			insertionResult: 'failed',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));

		const rawArguments = '  retry this\nexactly  ';
		const input = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(input, { target: { value: rawArguments } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		const reopened = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(reopened.value).toBe(rawArguments);
		await waitFor(() => expect(document.activeElement).toBe(reopened));
		expect(reopened.selectionStart).toBe(rawArguments.length);
		expect(reopened.selectionEnd).toBe(rawArguments.length);
	});

	it('keeps the caret at the end when a failed reopen draft equals the default', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
			firstDefaultArguments: 'staged changes',
			insertionResult: 'failed',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));
		const input = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe('staged changes'.length);
		await fireEvent.keyDown(input, { key: 'Enter' });

		const reopened = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(reopened.value).toBe('staged changes');
		await waitFor(() => expect(document.activeElement).toBe(reopened));
		expect(reopened.selectionStart).toBe('staged changes'.length);
		expect(reopened.selectionEnd).toBe('staged changes'.length);
	});

	it('reopens a failed cleared insertion without restoring the saved default', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
			firstDefaultArguments: 'saved default',
			insertionResult: 'failed',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));

		const reopened = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(reopened.value).toBe('');
	});

	it('settles an arguments cancel as a chain cancellation', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
		});
		const composer = screen.getByRole('textbox', { name: 'Composer prompt' });
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));

		const dialog = await screen.findByRole('dialog', {
			name: 'Arguments for /snippet item-0',
		});
		expect(screen.getByTestId('main-inert').textContent).toBe('true');
		dialog.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
		);
		expect(screen.getByTestId('main-inert').textContent).toBe('false');
		expect(document.activeElement).toBe(composer);

		await waitFor(() => expect(screen.getByTestId('cancel-count').textContent).toBe('1'));
		expect(screen.queryByRole('dialog', { name: 'Arguments for /snippet item-0' })).toBeNull();
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		expect(document.activeElement).toBe(composer);
	});

	it('reports a cancel when dismissed without a selection', async () => {
		render(ComposerSnippetPaletteTestHost);
		const composer = screen.getByRole('textbox', { name: 'Composer prompt' });

		await fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Insert Snippet' }), {
			key: 'Escape',
		});

		await waitFor(() => expect(screen.getByTestId('cancel-count').textContent).toBe('1'));
		expect(screen.getByTestId('palette-open').textContent).toBe('false');
		await waitFor(() => expect(document.activeElement).toBe(composer));
	});

	it('does not report a cancel after a selection', async () => {
		render(ComposerSnippetPaletteTestHost);
		const composer = screen.getByRole('textbox', { name: 'Composer prompt' });
		const option = await screen.findByRole('option', { name: /^item-3\b/ });
		expect(screen.getByTestId('main-inert').textContent).toBe('true');

		option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(screen.getByTestId('main-inert').textContent).toBe('false');
		expect(document.activeElement).toBe(composer);

		await waitFor(() => expect(screen.getByTestId('selected-snippet').textContent).toBe('item-3'));
		expect(screen.getByTestId('cancel-count').textContent).toBe('0');
	});

	it('closes the palette and arguments entry when the interaction key changes', async () => {
		render(ComposerSnippetPaletteTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
		});
		await fireEvent.click(await screen.findByRole('option', { name: /item-0/ }));
		await fireEvent.input(await screen.findByRole('textbox', { name: 'Arguments' }), {
			target: { value: 'old chat arguments' },
		});

		await fireEvent.click(screen.getByTestId('change-interaction-key'));

		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull());
		expect(screen.getByTestId('palette-open').textContent).toBe('false');
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		await waitFor(() => expect(screen.getByTestId('cancel-count').textContent).toBe('1'));
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Composer prompt' })),
		);
	});

	it('shows the context hint when the expansion context is unavailable', async () => {
		render(ComposerSnippetPaletteTestHost, {
			contextHint: 'Set a project path to insert snippets',
		});

		await screen.findByText('Set a project path to insert snippets');
		const option = screen.getByRole('option', { name: /^item-0\b/ });
		expect(option.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(option);
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		expect(screen.getByTestId('palette-open').textContent).toBe('true');
	});

	it('shows the configured trigger hint in the footer', async () => {
		render(ComposerSnippetPaletteTestHost);

		await screen.findByText('Tip: type ;; while composing to open this palette');
	});

	it('opens the snippets manager from the footer', async () => {
		render(ComposerSnippetPaletteTestHost);

		await fireEvent.click(await screen.findByRole('button', { name: 'Edit snippets' }));

		expect(screen.getByTestId('edit-count').textContent).toBe('1');
		expect(screen.getByTestId('cancel-count').textContent).toBe('0');
	});

	it('keeps the palette open when retrying a failed load', async () => {
		render(ComposerSnippetPaletteTestHost, { failLoads: true });

		await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

		await waitFor(() => expect(screen.getByTestId('load-count').textContent).toBe('2'));
		expect(screen.getByTestId('palette-open').textContent).toBe('true');
		expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
	});

	it('shows the empty states', async () => {
		render(ComposerSnippetPaletteTestHost, { count: 0 });
		await screen.findByText('No snippets yet');
		cleanup();

		render(ComposerSnippetPaletteTestHost);
		const search = await screen.findByRole('combobox', { name: 'Search snippets' });
		await fireEvent.input(search, { target: { value: 'zzz' } });
		await screen.findByText('No snippets match your search.');
	});
});

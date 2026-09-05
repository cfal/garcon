import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
import type { Preamble, PreamblesSnapshot } from '$shared/preambles';
import PreamblesSectionTestHost from './PreamblesSectionTestHost.svelte';

function globalPreamble(id: string, title: string, content: string): Preamble {
	return {
		id,
		enabled: true,
		title,
		content,
		scope: { type: 'global' },
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

function projectPreamble(id: string, title: string, content: string): Preamble {
	return {
		...globalPreamble(id, title, content),
		scope: {
			type: 'project-paths',
			rules: [{ projectPath: '/workspace/project', includeNested: true }],
		},
	};
}

describe('PreamblesSection', () => {
	it('renders singular and plural project path counts', () => {
		const single = projectPreamble('single-path', 'Single path', 'Single path body.');
		const multiple: Preamble = {
			...single,
			id: 'paths',
			title: 'Multiple paths',
			scope: {
				type: 'project-paths',
				rules: [
					{ projectPath: '/workspace/first', includeNested: true },
					{ projectPath: '/workspace/second', includeNested: false },
				],
			},
		};
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [single, multiple] },
		});

		expect(screen.getByText('1 project path')).toBeTruthy();
		expect(screen.getByText('2 project paths')).toBeTruthy();
	});

	it('filters by body and path and disables reordering while filtered', async () => {
		const snapshot: PreamblesSnapshot = {
			revision: 1,
			preambles: [
				globalPreamble('global', 'Global conventions', 'Use the shared defaults.'),
				projectPreamble('path', 'Project conventions', 'Run project checks.'),
			],
		};
		render(PreamblesSectionTestHost, { snapshot });
		const filter = screen.getByRole('searchbox', { name: 'Filter preambles' });

		await fireEvent.input(filter, { target: { value: 'project checks' } });
		expect(screen.queryByText('Global conventions')).toBeNull();
		expect(screen.getByText('Project conventions')).toBeTruthy();
		expect(
			(screen.getByRole('button', { name: 'Move Project conventions up' }) as HTMLButtonElement).disabled,
		).toBe(true);

		await fireEvent.input(filter, { target: { value: '/WORKSPACE/PROJECT' } });
		expect(screen.getByText('Project conventions')).toBeTruthy();
		await fireEvent.input(filter, { target: { value: 'missing' } });
		expect(screen.getByText('No matching preambles')).toBeTruthy();
	});

	it('disables a preamble directly from its catalog row', async () => {
		const enabled = globalPreamble('global', 'Global conventions', 'Use the shared defaults.');
		const disabled = { ...enabled, enabled: false };
		const update = vi.fn().mockResolvedValue({
			success: true,
			snapshot: { revision: 2, preambles: [disabled] },
		});
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [enabled] },
			deps: { update },
		});

		await fireEvent.click(screen.getByRole('switch', { name: 'Disable Global conventions' }));

		expect(update).toHaveBeenCalledWith({
			expectedRevision: 1,
			id: 'global',
			preamble: {
				enabled: false,
				title: 'Global conventions',
				content: 'Use the shared defaults.',
				scope: { type: 'global' },
			},
		});
		expect(await screen.findByText('Disabled')).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Enable Global conventions' })).toBeTruthy();
	});

	it('marks an open edit stale when the catalog revision changes', async () => {
		const original = globalPreamble('global', 'Global conventions', 'Use the shared defaults.');
		let store!: PreamblesStore;
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [original] },
			onStore: (value: PreamblesStore) => { store = value; },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Global conventions' }));
		await screen.findByRole('heading', { name: 'Edit Preamble' });
		store.applySnapshot({
			revision: 2,
			preambles: [{ ...original, title: 'Externally changed conventions' }],
		});

		await waitFor(() => {
			expect(screen.getByText(/changed while the editor was open/i)).toBeTruthy();
			expect(
				(screen.getByRole('button', { name: 'Save Preamble' }) as HTMLButtonElement).disabled,
			).toBe(true);
		});
	});

	it('shows the chat ID placeholder legend under the preamble composer', async () => {
		const original = globalPreamble('global', 'Global conventions', 'Use the shared defaults.');
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [original] },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Global conventions' }));

		const help = await screen.findByText(
			'Use {{chat_id}} for the chat receiving this preamble.',
		);
		const composer = screen.getByRole('textbox', { name: 'Preamble text' });
		expect(composer.getAttribute('aria-describedby')).toContain(help.id);
	});

	it('keeps an edit stale after a revision-conflict refresh', async () => {
		const original = globalPreamble('global', 'Global conventions', 'Use the shared defaults.');
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const update = vi.fn().mockRejectedValue(conflict);
		const get = vi.fn().mockResolvedValue({
			revision: 2,
			preambles: [{ ...original, title: 'Externally changed conventions' }],
		});
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [original] },
			deps: { get, update },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Global conventions' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Save Preamble' }));

		await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
			expectedRevision: 1,
		})));
		expect(get).toHaveBeenCalledOnce();
		expect(await screen.findByText(/changed while the editor was open/i)).toBeTruthy();
		const saveButton = await screen.findByRole('button', { name: 'Save Preamble' });
		expect(
			(saveButton as HTMLButtonElement).disabled,
		).toBe(true);
		await fireEvent.click(saveButton);
		expect(update).toHaveBeenCalledOnce();
	});

	it('stale-locks an edit when the revision-conflict refresh fails', async () => {
		const original = globalPreamble('global', 'Global conventions', 'Use the shared defaults.');
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const update = vi.fn().mockRejectedValue(conflict);
		const get = vi.fn().mockRejectedValue(new Error('refresh unavailable'));
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [original] },
			deps: { get, update },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Global conventions' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Save Preamble' }));

		expect(await screen.findByText(/changed while the editor was open/i)).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Save Preamble' }) as HTMLButtonElement).disabled)
			.toBe(true);
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Preamble text' }), {
			key: 'Enter',
			ctrlKey: true,
		});
		expect(update).toHaveBeenCalledOnce();
	});

	it('disables catalog entry points while a row mutation is pending', async () => {
		let resolveReorder!: (value: {
			success: true;
			snapshot: PreamblesSnapshot;
		}) => void;
		const reorder = vi.fn(() => new Promise<{
			success: true;
			snapshot: PreamblesSnapshot;
		}>((resolve) => { resolveReorder = resolve; }));
		const first = globalPreamble('first', 'First conventions', 'First body.');
		const second = globalPreamble('second', 'Second conventions', 'Second body.');
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [first, second] },
			deps: { reorder },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Move Second conventions up' }));
		await waitFor(() => expect(reorder).toHaveBeenCalledOnce());
		expect((screen.getByRole('button', { name: 'Add preamble' }) as HTMLButtonElement).disabled)
			.toBe(true);
		expect((screen.getByRole('button', { name: 'Refresh preambles' }) as HTMLButtonElement).disabled)
			.toBe(true);

		resolveReorder({
			success: true,
			snapshot: { revision: 2, preambles: [second, first] },
		});
		await waitFor(() => {
			expect((screen.getByRole('button', { name: 'Add preamble' }) as HTMLButtonElement).disabled)
				.toBe(false);
		});
	});

	it('associates scope errors with each invalid project path input', async () => {
		const scoped = projectPreamble('path', 'Project conventions', 'Project body.');
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [scoped] },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Project conventions' }));
		const pathInput = await screen.findByRole('textbox', { name: 'Project path' });
		await fireEvent.input(pathInput, { target: { value: '' } });
		const error = screen.getByText('Add at least one project path.');

		expect(pathInput.getAttribute('aria-invalid')).toBe('true');
		expect(pathInput.getAttribute('aria-describedby')).toContain(error.id);
	});

	it('associates mixed blank and duplicate paths with their specific errors', async () => {
		const scoped = {
			...projectPreamble('path', 'Project conventions', 'Project body.'),
			scope: {
				type: 'project-paths' as const,
				rules: [
					{ projectPath: '/workspace/first', includeNested: false },
					{ projectPath: '/workspace/second', includeNested: false },
					{ projectPath: '/workspace/third', includeNested: false },
				],
			},
		};
		render(PreamblesSectionTestHost, {
			snapshot: { revision: 1, preambles: [scoped] },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Project conventions' }));
		const pathInputs = await screen.findAllByRole('textbox', { name: 'Project path' });
		await fireEvent.input(pathInputs[0]!, { target: { value: '' } });
		await fireEvent.input(pathInputs[1]!, { target: { value: '/workspace/duplicate' } });
		await fireEvent.input(pathInputs[2]!, { target: { value: '/workspace/duplicate' } });

		const descriptions = pathInputs.map((input) => document.getElementById(
			input.getAttribute('aria-describedby') ?? '',
		)?.textContent);
		expect(descriptions[0]).toContain('at least one');
		expect(descriptions[1]).toContain('unique');
		expect(descriptions[2]).toContain('unique');
	});
});

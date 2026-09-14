import { fireEvent, render, screen } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
// Snapshot assertions do not depend on cold renderer transformation timing.
import '../FileConflictDiff.svelte';
import FileConflictComparison from '../FileConflictComparison.svelte';

vi.mock('$lib/utils/lazy-renderer.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/utils/lazy-renderer.js')>();
	return { ...actual, lazyRenderer: vi.fn(actual.lazyRenderer) };
});

describe('FileConflictComparison', () => {
	it('shows a localized failure when the comparison renderer cannot load', async () => {
		const failure = new Error('Failed to fetch dynamically imported module: /assets/diff.js');
		vi.mocked(lazyRenderer).mockReturnValueOnce(() => Promise.reject(failure));
		const onCancel = vi.fn();
		render(FileConflictComparison, {
			baseContent: 'base',
			localContent: 'local',
			diskContent: 'disk',
			lineSeparator: '\n',
			onCancel,
			onAcceptDisk: vi.fn(),
			onSaveChecked: vi.fn(),
		});

		expect(await screen.findByText(m.file_conflict_failed())).toBeTruthy();
		expect(screen.queryByText(failure.message)).toBeNull();
		for (const name of ['Accept disk', 'Save against displayed disk']) {
			expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
		}
		await fireEvent.click(screen.getByRole('button', { name: m.common_cancel() }));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it.each(['local', 'base'] as const)(
		'resets the resolution editor when only the %s snapshot changes',
		async (changedSnapshot) => {
			const onSaveChecked = vi.fn();
			const props = {
				baseContent: 'base',
				localContent: 'local',
				diskContent: 'disk',
				lineSeparator: '\n' as const,
				onCancel: vi.fn(),
				onAcceptDisk: vi.fn(),
				onSaveChecked,
			};
			const rendered = render(FileConflictComparison, props);
			const resolutionEditor = () => {
				const element = rendered.container.querySelectorAll<HTMLElement>('.cm-editor')[1];
				const editor = element && EditorView.findFromDOM(element);
				if (!editor) throw new Error('Expected resolution editor');
				return editor;
			};
			await vi.waitFor(() => expect(resolutionEditor().state.doc.toString()).toBe('local'));
			const original = resolutionEditor();
			original.dispatch({ changes: { from: 0, to: 5, insert: 'previous edit' } });
			await tick();
			expect(resolutionEditor()).toBe(original);
			await fireEvent.click(screen.getByRole('button', { name: 'Save against displayed disk' }));
			expect(onSaveChecked).toHaveBeenLastCalledWith('previous edit');

			const next = { ...props, [`${changedSnapshot}Content`]: `next ${changedSnapshot}` };
			await rendered.rerender(next);
			await vi.waitFor(() =>
				expect(resolutionEditor().state.doc.toString()).toBe(next.localContent),
			);
			expect(screen.getByRole('tab', { name: 'Disk' }).getAttribute('aria-selected')).toBe('true');
			const current = resolutionEditor();
			current.dispatch({ changes: { from: current.state.doc.length, insert: ' resolved' } });
			await fireEvent.click(screen.getByRole('button', { name: 'Save against displayed disk' }));
			expect(onSaveChecked).toHaveBeenLastCalledWith(`${next.localContent} resolved`);
		},
	);

	it('exposes complete tab semantics and explicit resolution actions', async () => {
		const onSaveChecked = vi.fn();
		render(FileConflictComparison, {
			baseContent: 'base',
			localContent: 'local',
			diskContent: 'disk',
			lineSeparator: '\n',
			onCancel: vi.fn(),
			onAcceptDisk: vi.fn(),
			onSaveChecked,
		});

		const tabs = screen.getAllByRole('tab');
		expect(tabs.map((tab) => tab.textContent)).toEqual(['Base', 'Disk']);
		expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
		expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
			'file-conflict-disk-tab',
		);
		tabs[1]!.focus();
		await fireEvent.keyDown(tabs[1]!, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(tabs[0]);
		expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
		await fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(tabs[1]);
		await vi.waitFor(() =>
			expect(
				(screen.getByRole('button', { name: 'Save against displayed disk' }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		expect(screen.getByRole('group', { name: m.file_conflict_comparison() })).toBeTruthy();
		expect(document.querySelectorAll('[aria-label="Comparison snapshot"]')).toHaveLength(1);
		expect(document.querySelectorAll('[aria-label="Resolution copy"]')).toHaveLength(1);
		await fireEvent.click(screen.getByRole('button', { name: 'Save against displayed disk' }));
		expect(screen.queryByRole('button', { name: 'Replace disk' })).toBeNull();
		expect(onSaveChecked).toHaveBeenCalledWith('local');
	});

	it('allows resolution against an empty disk snapshot once the comparison is ready', async () => {
		const onAcceptDisk = vi.fn();
		const onSaveChecked = vi.fn();
		render(FileConflictComparison, {
			baseContent: 'base',
			localContent: 'local',
			diskContent: '',
			lineSeparator: '\n',
			onCancel: vi.fn(),
			onAcceptDisk,
			onSaveChecked,
		});

		const accept = screen.getByRole('button', { name: 'Accept disk' }) as HTMLButtonElement;
		const save = screen.getByRole('button', {
			name: 'Save against displayed disk',
		}) as HTMLButtonElement;
		await vi.waitFor(() => {
			expect(accept.disabled).toBe(false);
			expect(save.disabled).toBe(false);
		});
		await fireEvent.click(accept);
		expect(onAcceptDisk).toHaveBeenCalledOnce();
		await fireEvent.click(save);
		expect(onSaveChecked).toHaveBeenCalledWith('local');
	});
});

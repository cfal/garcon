import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
import * as m from '$lib/paraglide/messages.js';
import '../FileConflictDiff.svelte';
import FileRecoveryCopies from '../FileRecoveryCopies.svelte';

vi.mock('$lib/utils/lazy-renderer.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/utils/lazy-renderer.js')>();
	return { ...actual, lazyRenderer: vi.fn(actual.lazyRenderer) };
});

const files = vi.hoisted(
	() =>
		({
			resolveRecoveredCopy: vi.fn<FileSessionRegistry['resolveRecoveredCopy']>(),
			exportContent: vi.fn<FileSessionRegistry['exportContent']>(),
			retryRecoveryDiscovery: vi.fn<FileSessionRegistry['retryRecoveryDiscovery']>(),
		}) satisfies Pick<
			FileSessionRegistry,
			'resolveRecoveredCopy' | 'exportContent' | 'retryRecoveryDiscovery'
		>,
);
vi.mock('$lib/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/context')>()),
	getFileSessions: () => files,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function session() {
	const document = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.txt' },
		'file',
	);
	document.content = 'current edit';
	document.recoveredCopies = [
		{ id: 'recovered', content: 'recovered edit', savedAt: 1, hasUnknownSubmission: true },
	];
	return new FileViewSession(document);
}

describe('FileRecoveryCopies', () => {
	it.each([
		['Keep current copy', 'keep-current'],
		['Use recovered copy', 'use-recovered'],
	] as const)('compares read-only snapshots and delegates %s', async (label, choice) => {
		const view = session();
		files.resolveRecoveredCopy.mockImplementation(async () => {
			view.document.recoveredCopies = [];
			return true;
		});
		render(FileRecoveryCopies, { session: view });
		await fireEvent.click(screen.getByRole('button', { name: /^Export recovered copy/ }));
		expect(files.exportContent).toHaveBeenCalledWith(view.id, 'recovered');
		await fireEvent.click(screen.getByRole('button', { name: /^Compare recovered copy/ }));
		const dialog = await screen.findByRole('dialog', { name: 'Recovered copy' });
		await vi.waitFor(() => expect(dialog.querySelectorAll('.cm-editor')).toHaveLength(2));
		const editors = [...dialog.querySelectorAll<HTMLElement>('.cm-editor')].map((element) =>
			EditorView.findFromDOM(element)!,
		);
		expect(editors.map((editor) => editor.state.doc.toString())).toEqual([
			'current edit',
			'recovered edit',
		]);
		expect(editors.every((editor) => editor.state.facet(EditorState.readOnly))).toBe(true);
		expect(editors.map((editor) => editor.contentDOM.getAttribute('aria-label'))).toEqual([
			'Current copy',
			'Recovered copy',
		]);
		expect(within(dialog).getByText(/An unfinished Save is retained/)).toBeTruthy();
		await fireEvent.click(within(dialog).getByRole('button', { name: label }));
		expect(files.resolveRecoveredCopy).toHaveBeenCalledWith(view.id, 'recovered', choice);
		await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		view.dispose();
	});

	it('keeps the dialog after failure and permits retry or cancellation', async () => {
		const view = session();
		files.resolveRecoveredCopy.mockImplementation(async () => {
			view.document.recoveryResolutionError = 'Both copies are retained.';
			return false;
		});
		render(FileRecoveryCopies, { session: view });
		await fireEvent.click(screen.getByRole('button', { name: /^Compare recovered copy/ }));
		await vi.waitFor(() => expect(document.querySelectorAll('.cm-editor')).toHaveLength(2));
		await fireEvent.click(await screen.findByRole('button', { name: 'Use recovered copy' }));
		expect((await screen.findByRole('alert')).textContent).toBe('Both copies are retained.');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
		expect(files.retryRecoveryDiscovery).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(view.document.recoveredCopies).toHaveLength(1);
		view.dispose();
	});

	it('distinguishes copies and blocks resolution after renderer failure', async () => {
		vi.mocked(lazyRenderer).mockReturnValueOnce(() =>
			Promise.reject(new Error('renderer unavailable')),
		);
		const view = session();
		view.document.recoveredCopies = [
			...view.document.recoveredCopies,
			{ id: 'second', content: 'second copy', savedAt: 1, hasUnknownSubmission: false },
		];
		render(FileRecoveryCopies, { session: view });
		const compare = screen.getAllByRole('button', { name: /^Compare recovered copy/ });
		expect(compare.map((button) => button.getAttribute('aria-label'))).toEqual([
			`Compare recovered copy 1, ${new Date(1).toLocaleString()}`,
			`Compare recovered copy 2, ${new Date(1).toLocaleString()}`,
		]);
		await fireEvent.click(compare[1]!);
		await screen.findByText(m.file_conflict_failed());
		for (const name of ['Keep current copy', 'Use recovered copy']) {
			const button = screen.getByRole('button', { name }) as HTMLButtonElement;
			expect(button.disabled).toBe(true);
			await fireEvent.click(button);
		}
		expect(files.resolveRecoveredCopy).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		view.dispose();
	});
});

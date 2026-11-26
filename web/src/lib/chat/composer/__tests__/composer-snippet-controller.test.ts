import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { expandSnippet } from '$lib/api/snippets.js';
import { ComposerSnippetController } from '$lib/chat/composer/composer-snippet-controller.js';
import type { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import {
	preambleToSelectable,
	snippetToSelectable,
} from '$lib/snippets/selectable-snippet.js';
import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import { SNIPPET_ARGUMENTS_MAX_LENGTH, type ExpandSnippetResponse, type Snippet } from '$shared/snippets';
import type { Preamble } from '$shared/preambles';

vi.mock('$lib/api/snippets.js', () => ({ expandSnippet: vi.fn() }));
const expandMock = vi.mocked(expandSnippet);

const CHAT_ID = '1787471053739199';

function makeSnippet(overrides: Partial<Snippet> = {}): Snippet {
	return {
		id: 'snippet-review',
		shortName: 'review',
		template: 'Review {{arguments}}',
		defaultArguments: 'staged changes',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makePreamble(overrides: Partial<Preamble> = {}): Preamble {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		enabled: false,
		title: 'Manual context',
		snippetShortName: 'context',
		content: 'Context {{chat_id}}',
		scope: { type: 'global' },
		agentIds: [],
		tagFilter: { mode: 'any', tags: [] },
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeServerResponse(overrides: Partial<ExpandSnippetResponse> = {}): ExpandSnippetResponse {
	return {
		success: true,
		source: 'snippet',
		sourceId: 'snippet-review',
		sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
		shortName: 'review',
		contextExecutorId: 'local',
		contextProjectPath: '/workspace/project',
		expandedText: 'Server expanded',
		...overrides,
	};
}

function makePalette(trigger: SnippetPaletteTriggerState['trigger'] = null) {
	return {
		trigger,
		complete: vi.fn<() => void>(),
		dismiss: vi.fn<() => void>(),
	};
}

interface FixtureOverrides {
	snippetsList?: Snippet[];
	preamblesList?: Preamble[];
	preloadCatalogs?: boolean;
	wsConnected?: boolean;
	executionKey?: string;
	conversationInput?: boolean;
	transformPending?: boolean;
	text?: string;
	selection?: { start: number; end: number } | null;
	hasProjectPath?: boolean;
	onMissingProjectPath?: (() => void) | null;
	matchesServerContext?: boolean;
}

function createFixture(overrides: FixtureOverrides = {}) {
	const getSnippets = vi.fn(async () => ({
		revision: 1,
		snippets: overrides.snippetsList ?? [makeSnippet()],
	}));
	const getPreambles = vi.fn(async () => ({
		revision: 1,
		preambles: overrides.preamblesList ?? [makePreamble()],
	}));
	const snippets = createSnippetsStore({ get: getSnippets });
	const preambles = createPreamblesStore({ get: getPreambles });
	if (overrides.preloadCatalogs !== false) {
		snippets.applySnapshot({
			revision: 1,
			snippets: overrides.snippetsList ?? [makeSnippet()],
		});
		preambles.applySnapshot({
			revision: 1,
			preambles: overrides.preamblesList ?? [makePreamble()],
		});
	}

	const state = {
		wsConnected: overrides.wsConnected ?? true,
		executionKey: overrides.executionKey ?? 'local\u0000/workspace/project',
		conversationInput: overrides.conversationInput ?? true,
		transformPending: overrides.transformPending ?? false,
		text: overrides.text ?? 'Before after',
		selection:
			overrides.selection === undefined ? { start: 7, end: 7 } : overrides.selection,
		hasProjectPath: overrides.hasProjectPath ?? true,
		matchesServerContext: overrides.matchesServerContext ?? true,
	};

	const notifications = { error: vi.fn() };
	const beforeExpand = vi.fn();
	const onMissingProjectPath =
		overrides.onMissingProjectPath === null ? undefined : (overrides.onMissingProjectPath ?? vi.fn());
	const onExpanded = vi.fn(async () => {});
	const onSettled = vi.fn(async () => {});
	const prepareServerContext = vi.fn(async (_signal: AbortSignal) => ({
		requestContext: { type: 'chat' as const, chatId: CHAT_ID },
		prepared: { executorId: 'local', projectPath: '/workspace/project' },
	}));
	const matchesServerContext = vi.fn(() => state.matchesServerContext);

	const controller = new ComposerSnippetController({
		snippets,
		preambles,
		notifications,
		isWsConnected: () => state.wsConnected,
		getExecutionKey: () => state.executionKey,
		isConversationInput: () => state.conversationInput,
		isTransformPending: () => state.transformPending,
		getText: () => state.text,
		getSelection: () => state.selection,
		hasProjectPath: () => state.hasProjectPath,
		getLocalChatId: () => CHAT_ID,
		prepareServerContext,
		matchesServerContext,
		beforeExpand,
		onMissingProjectPath,
		onExpanded,
		onSettled,
	});

	return {
		controller,
		snippets,
		preambles,
		getSnippets,
		getPreambles,
		state,
		notifications,
		beforeExpand,
		onMissingProjectPath,
		onExpanded,
		onSettled,
		prepareServerContext,
		matchesServerContext,
	};
}

beforeEach(() => {
	expandMock.mockReset();
});

describe('ComposerSnippetController', () => {
	describe('insertFromPalette settlement rules', () => {
		it('completes the palette on local snippet insertion without invoking server expansion or pending', async () => {
			const fixture = createFixture({ text: 'Before ;;review after' });
			const snippet = snippetToSelectable(makeSnippet());
			const palette = makePalette({ start: 7, end: 15, query: 'review' });

			const resultPromise = fixture.controller.insertFromPalette(palette, snippet, 'the API');
			expect(fixture.controller.pending).toBe(false);
			expect(await resultPromise).toBe('inserted');

			expect(palette.complete).toHaveBeenCalledOnce();
			expect(palette.dismiss).not.toHaveBeenCalled();
			expect(fixture.beforeExpand).toHaveBeenCalledOnce();
			expect(fixture.prepareServerContext).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();
			expect(fixture.onExpanded).toHaveBeenCalledExactlyOnceWith(
				'Before Review the API after',
				'Before Review the API'.length,
			);
			expect(fixture.onSettled).not.toHaveBeenCalled();
		});

		it('keeps the palette open on failed local or server expansion for argument snippets', async () => {
			const localFixture = createFixture({
				snippetsList: [makeSnippet({ template: '{{arguments}}{{arguments}}{{arguments}}' })],
			});
			const argSnippet = snippetToSelectable(
				makeSnippet({ template: '{{arguments}}{{arguments}}{{arguments}}' }),
			);
			const localPalette = makePalette();
			expect(
				await localFixture.controller.insertFromPalette(
					localPalette,
					argSnippet,
					'x'.repeat(25_000),
				),
			).toBe('failed');
			expect(localPalette.complete).not.toHaveBeenCalled();
			expect(localPalette.dismiss).not.toHaveBeenCalled();
			expect(localFixture.notifications.error).toHaveBeenCalledOnce();
			expect(localFixture.onSettled).toHaveBeenCalledOnce();
			expect(expandMock).not.toHaveBeenCalled();

			const serverFixture = createFixture({
				snippetsList: [makeSnippet({ template: 'Review {{arguments}} in {{project_path}}' })],
			});
			expandMock.mockRejectedValueOnce(new Error('server down'));
			const pathArgSnippet = snippetToSelectable(
				makeSnippet({ template: 'Review {{arguments}} in {{project_path}}' }),
			);
			const serverPalette = makePalette();
			expect(await serverFixture.controller.insertFromPalette(serverPalette, pathArgSnippet, 'PR')).toBe(
				'failed',
			);
			expect(serverPalette.complete).not.toHaveBeenCalled();
			expect(serverPalette.dismiss).not.toHaveBeenCalled();
			expect(serverFixture.notifications.error).toHaveBeenCalledWith(
				'Snippet expansion failed: server down',
			);
			expect(serverFixture.onSettled).toHaveBeenCalledOnce();
		});

		it('dismisses the palette on failure for static snippets and preambles containing {{arguments}}', async () => {
			const staticSnippet = makeSnippet({ template: 'Review in {{project_path}}' });
			const literalArgPreamble = makePreamble({
				content: 'Literal {{arguments}} on {{current_date}}',
			});
			const fixture = createFixture({
				snippetsList: [staticSnippet],
				preamblesList: [literalArgPreamble],
			});

			expandMock.mockRejectedValueOnce(new Error('static failed'));
			const staticPalette = makePalette();
			expect(
				await fixture.controller.insertFromPalette(
					staticPalette,
					snippetToSelectable(staticSnippet),
					'',
				),
			).toBe('failed');
			expect(staticPalette.dismiss).toHaveBeenCalledOnce();

			expandMock.mockRejectedValueOnce(new Error('preamble failed'));
			const preamblePalette = makePalette();
			expect(
				await fixture.controller.insertFromPalette(
					preamblePalette,
					preambleToSelectable(literalArgPreamble)!,
					'',
				),
			).toBe('failed');
			expect(preamblePalette.dismiss).toHaveBeenCalledOnce();
		});

		it('dismisses the palette on cancelled insertions', async () => {
			const fixture = createFixture({ transformPending: true });
			const palette = makePalette();
			expect(
				await fixture.controller.insertFromPalette(palette, snippetToSelectable(makeSnippet()), ''),
			).toBe('cancelled');
			expect(palette.dismiss).toHaveBeenCalledOnce();
			expect(fixture.beforeExpand).not.toHaveBeenCalled();

			const nullSelectionFixture = createFixture({ selection: null });
			const nullPalette = makePalette();
			expect(
				await nullSelectionFixture.controller.insertFromPalette(
					nullPalette,
					snippetToSelectable(makeSnippet()),
					'',
				),
			).toBe('cancelled');
			expect(nullPalette.dismiss).toHaveBeenCalledOnce();
			expect(nullSelectionFixture.beforeExpand).not.toHaveBeenCalled();

			const changedFixture = createFixture({ snippetsList: [] });
			const changedPalette = makePalette();
			expect(
				await changedFixture.controller.insertFromPalette(
					changedPalette,
					snippetToSelectable(makeSnippet()),
					'',
				),
			).toBe('cancelled');
			expect(changedPalette.dismiss).toHaveBeenCalledOnce();
			expect(changedFixture.notifications.error).toHaveBeenCalledWith(
				'That snippet changed. Select it again.',
			);
			expect(changedFixture.onSettled).toHaveBeenCalledOnce();
		});
	});

	describe('early guards and missing project path handling', () => {
		it('ignores expandInvocation without calling beforeExpand when non-conversational or transform-pending', async () => {
			const nonConversation = createFixture({ conversationInput: false });
			await nonConversation.controller.expandInvocation({
				kind: 'valid',
				shortName: 'review',
				arguments: { type: 'default' },
			});
			expect(nonConversation.beforeExpand).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();

			const pendingTransform = createFixture({ transformPending: true });
			await pendingTransform.controller.expandInvocation({
				kind: 'valid',
				shortName: 'review',
				arguments: { type: 'default' },
			});
			expect(pendingTransform.beforeExpand).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();
		});

		it('reports missing project path asymmetrically when onMissingProjectPath is configured', async () => {
			const fixture = createFixture({ hasProjectPath: false });
			const palette = makePalette();

			expect(
				await fixture.controller.insertFromPalette(palette, snippetToSelectable(makeSnippet()), ''),
			).toBe('cancelled');
			expect(fixture.onMissingProjectPath).toHaveBeenCalledTimes(1);
			expect(fixture.onSettled).toHaveBeenCalledTimes(1);
			expect(palette.dismiss).toHaveBeenCalledOnce();
			expect(fixture.prepareServerContext).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();

			await fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'review',
				arguments: { type: 'default' },
			});
			expect(fixture.onMissingProjectPath).toHaveBeenCalledTimes(2);
			expect(fixture.onSettled).toHaveBeenCalledTimes(1);
			expect(fixture.prepareServerContext).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();
		});

		it('falls back to server expansion when onMissingProjectPath is omitted and hasProjectPath is false', async () => {
			const fixture = createFixture({
				hasProjectPath: false,
				onMissingProjectPath: null,
			});
			expandMock.mockResolvedValue(makeServerResponse());

			const palette = makePalette();
			expect(
				await fixture.controller.insertFromPalette(palette, snippetToSelectable(makeSnippet()), ''),
			).toBe('inserted');
			expect(fixture.prepareServerContext).toHaveBeenCalledTimes(1);
			expect(expandMock).toHaveBeenCalledTimes(1);

			fixture.state.text = '/s review';
			await fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'review',
				arguments: { type: 'default' },
			});
			expect(fixture.prepareServerContext).toHaveBeenCalledTimes(2);
			expect(expandMock).toHaveBeenCalledTimes(2);
			expect(fixture.onExpanded).toHaveBeenLastCalledWith('Server expanded', 'Server expanded'.length);
		});
	});

	describe('local slash expansion', () => {
		it('expands preambles and snippets locally via expandInvocation without toggles to pending', async () => {
			const fixture = createFixture({ text: '/s context' });
			await fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'context',
				arguments: { type: 'default' },
			});
			expect(fixture.controller.pending).toBe(false);
			expect(fixture.prepareServerContext).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();
			expect(fixture.onExpanded).toHaveBeenCalledExactlyOnceWith(
				`Context ${CHAT_ID}`,
				`Context ${CHAT_ID}`.length,
			);
		});

		it('notifies and settles without server calls when slash local expansion fails bounds checks', async () => {
			const fixture = createFixture({ text: '/s review' });
			await fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'review',
				arguments: { type: 'value', value: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1) },
			});
			expect(fixture.notifications.error).toHaveBeenCalledWith(
				'Snippet expansion failed: Snippet is invalid',
			);
			expect(fixture.onSettled).toHaveBeenCalledOnce();
			expect(fixture.onExpanded).not.toHaveBeenCalled();
			expect(fixture.prepareServerContext).not.toHaveBeenCalled();
			expect(expandMock).not.toHaveBeenCalled();
		});
	});

	describe('server fallback identity, staleness, cancellation, and errors', () => {
		it('refreshes only the owning loaded catalog when server response mismatches selection', async () => {
			const pathSnippet = makeSnippet({ template: 'Review in {{project_path}}' });
			const datePreamble = makePreamble({ content: 'Context {{current_date}}' });
			const fixture = createFixture({
				snippetsList: [pathSnippet],
				preamblesList: [datePreamble],
			});

			expandMock.mockResolvedValueOnce(
				makeServerResponse({ source: 'snippet', sourceUpdatedAt: '2026-01-02T00:00:00.000Z' }),
			);
			const snippetPalette = makePalette();
			expect(
				await fixture.controller.insertFromPalette(
					snippetPalette,
					snippetToSelectable(pathSnippet),
					'',
				),
			).toBe('cancelled');
			expect(fixture.getSnippets).toHaveBeenCalledTimes(1);
			expect(fixture.getPreambles).not.toHaveBeenCalled();
			expect(fixture.notifications.error).toHaveBeenCalledWith(
				'That snippet changed. Select it again.',
			);
			expect(fixture.onSettled).toHaveBeenCalledTimes(1);

			expandMock.mockResolvedValueOnce(
				makeServerResponse({
					source: 'preamble',
					sourceId: datePreamble.id,
					sourceUpdatedAt: '2026-01-02T00:00:00.000Z',
					shortName: 'context',
				}),
			);
			const preamblePalette = makePalette();
			expect(
				await fixture.controller.insertFromPalette(
					preamblePalette,
					preambleToSelectable(datePreamble)!,
					'',
				),
			).toBe('cancelled');
			expect(fixture.getSnippets).toHaveBeenCalledTimes(1);
			expect(fixture.getPreambles).toHaveBeenCalledTimes(1);
			expect(fixture.onSettled).toHaveBeenCalledTimes(2);
		});

		it('cancels without extra catalog refresh if catalog item changes while server matches old metadata', async () => {
			const pathSnippet = makeSnippet({ template: 'Review in {{project_path}}' });
			const fixture = createFixture({ snippetsList: [pathSnippet] });
			const server = Promise.withResolvers<ExpandSnippetResponse>();
			expandMock.mockReturnValueOnce(server.promise);

			const inserting = fixture.controller.insertFromPalette(
				makePalette(),
				snippetToSelectable(pathSnippet),
				'',
			);
			await vi.waitFor(() => expect(expandMock).toHaveBeenCalledOnce());

			fixture.snippets.applySnapshot({
				revision: 2,
				snippets: [makeSnippet({ template: 'Changed {{project_path}}', updatedAt: '2026-01-02T00:00:00.000Z' })],
			});
			server.resolve(makeServerResponse());

			expect(await inserting).toBe('cancelled');
			expect(fixture.getSnippets).not.toHaveBeenCalled();
			expect(fixture.notifications.error).toHaveBeenCalledWith(
				'That snippet changed. Select it again.',
			);
			expect(fixture.onExpanded).not.toHaveBeenCalled();
		});

		it.each(['executionKey', 'text', 'matchesServerContext'] as const)(
			'discards insertFromPalette server result when %s becomes stale mid-flight',
			async (reason) => {
				const pathSnippet = makeSnippet({ template: 'Review in {{project_path}}' });
				const fixture = createFixture({ snippetsList: [pathSnippet] });
				const server = Promise.withResolvers<ExpandSnippetResponse>();
				expandMock.mockReturnValueOnce(server.promise);

				const inserting = fixture.controller.insertFromPalette(
					makePalette(),
					snippetToSelectable(pathSnippet),
					'',
				);
				await vi.waitFor(() => expect(expandMock).toHaveBeenCalledOnce());

				if (reason === 'executionKey') fixture.state.executionKey = 'other\u0000/other';
				if (reason === 'text') fixture.state.text = 'edited draft';
				if (reason === 'matchesServerContext') fixture.state.matchesServerContext = false;
				server.resolve(makeServerResponse());

				expect(await inserting).toBe('cancelled');
				expect(fixture.onExpanded).not.toHaveBeenCalled();
				expect(fixture.notifications.error).not.toHaveBeenCalled();
			},
		);

		it.each(['conversationInput', 'executionKey', 'text', 'matchesServerContext'] as const)(
			'discards expandInvocation server result when %s changes mid-flight',
			async (reason) => {
				const fixture = createFixture({
					preloadCatalogs: false,
					text: '/s review',
				});
				const server = Promise.withResolvers<ExpandSnippetResponse>();
				expandMock.mockReturnValueOnce(server.promise);

				const invoking = fixture.controller.expandInvocation({
					kind: 'valid',
					shortName: 'review',
					arguments: { type: 'default' },
				});
				await vi.waitFor(() => expect(expandMock).toHaveBeenCalledOnce());

				if (reason === 'conversationInput') fixture.state.conversationInput = false;
				if (reason === 'executionKey') fixture.state.executionKey = 'other\u0000/other';
				if (reason === 'text') fixture.state.text = 'user typed';
				if (reason === 'matchesServerContext') fixture.state.matchesServerContext = false;
				server.resolve(makeServerResponse());

				await invoking;
				expect(fixture.onExpanded).not.toHaveBeenCalled();
				expect(fixture.notifications.error).not.toHaveBeenCalled();
			},
		);

		it('aborts preparation or in-flight server calls on cancel() without error notifications', async () => {
			const fixture = createFixture({ preloadCatalogs: false, text: '/s review' });
			let capturedSignal!: AbortSignal;
			expandMock.mockImplementationOnce(
				(_req, opts) =>
					new Promise((_resolve, reject) => {
						capturedSignal = opts?.signal as AbortSignal;
						capturedSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
					}),
			);

			const invoking = fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'review',
				arguments: { type: 'default' },
			});
			await vi.waitFor(() => expect(expandMock).toHaveBeenCalledOnce());
			expect(fixture.controller.pending).toBe(true);

			fixture.controller.cancel();
			expect(capturedSignal.aborted).toBe(true);
			expect(fixture.controller.pending).toBe(false);

			await invoking;
			expect(fixture.onExpanded).not.toHaveBeenCalled();
			expect(fixture.notifications.error).not.toHaveBeenCalled();
		});

		it('refreshes both catalogs on 404 errors and neither catalog on non-404 errors', async () => {
			const fixture = createFixture({
				snippetsList: [makeSnippet({ template: 'In {{project_path}}' })],
				text: '/s missing',
			});

			expandMock.mockRejectedValueOnce(new ApiError(404, 'Not found', 'SNIPPET_NOT_FOUND'));
			await fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'missing',
				arguments: { type: 'default' },
			});
			expect(fixture.getSnippets).toHaveBeenCalledTimes(1);
			expect(fixture.getPreambles).toHaveBeenCalledTimes(1);
			expect(fixture.notifications.error).toHaveBeenCalledWith('Snippet expansion failed: Not found');
			expect(fixture.onSettled).toHaveBeenCalledTimes(1);

			expandMock.mockRejectedValueOnce(new ApiError(422, 'Too long', 'SNIPPET_EXPANSION_TOO_LONG'));
			await fixture.controller.expandInvocation({
				kind: 'valid',
				shortName: 'missing',
				arguments: { type: 'default' },
			});
			expect(fixture.getSnippets).toHaveBeenCalledTimes(1);
			expect(fixture.getPreambles).toHaveBeenCalledTimes(1);
			expect(fixture.notifications.error).toHaveBeenCalledWith('Snippet expansion failed: Too long');
			expect(fixture.onSettled).toHaveBeenCalledTimes(2);
		});
	});
});

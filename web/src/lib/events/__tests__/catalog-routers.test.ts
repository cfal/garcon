import { describe, expect, it, vi } from 'vitest';
import * as events from '$shared/ws-events';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import { openPushFixture } from '$lib/ws/__tests__/push-fixture';
import { createDrainCursor } from '$lib/ws/drain';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub';
import { subscribeWorkspaceEvents } from '../workspace-router';
import { TranscriptSearchStatusController } from '../transcript-search-status-controller';

function makeSnapshot(overrides: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
	return {
		version: 1,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: {
				enabled: true,
				chatIdDiscovery: true,
				sendMessage: true,
				startAgent: true,
				resumeAgent: true,
				schedule: true,
				tickets: true,
			},
		},
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [
			{
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
		...overrides,
	};
}

describe('workspace event routing over the socket', () => {
	it('delivers validated pushes immediately without taking them from the conversation drain', () => {
		const fixture = openPushFixture();
		const parsed = vi.spyOn(events, 'parseServerWsMessage');
		const ticketsInvalidations = new TicketsInvalidationHub();
		const receivedTicket = vi.fn();
		const unsubscribeTicket = ticketsInvalidations.subscribe(receivedTicket);
		const targets = {
			apiProviders: { invalidate: vi.fn() },
			chatBoardInvalidations: { publish: vi.fn() },
			executors: new ExecutorsStore(),
			preambles: { refreshIfLoaded: vi.fn() },
			preambleSelections: { publish: vi.fn() },
			pullRequestReviews: { invalidate: vi.fn() },
			remoteSettings: { applySnapshot: vi.fn() },
			scheduledPrompts: { refreshIfLoaded: vi.fn() },
			snippets: { refreshIfLoaded: vi.fn() },
			ticketsInvalidations,
		} satisfies Parameters<typeof subscribeWorkspaceEvents>[1];
		const unsubscribe = subscribeWorkspaceEvents(fixture.ws, targets);
		const cursor = createDrainCursor(fixture.ws);
		const onStatus = vi.fn();
		const status = new TranscriptSearchStatusController(fixture.ws, onStatus);
		status.start();
		const snapshot = makeSnapshot({ version: 2 });
		const frames = [
			new events.ApiProvidersInvalidatedMessage(),
			{ type: 'chat-boards-invalidated', revision: 7, reason: 'reordered' },
			{ type: 'executors-changed', executors: [localExecutor, remoteExecutor] },
			{ type: 'executors-changed', executors: [{ ...localExecutor, secret: 'private' }] },
			{ type: 'preambles-invalidated', reason: 'updated' },
			{ type: 'chat-preambles-invalidated', chatId: '1700000000000001', revision: 3 },
			{ type: 'pull-request-reviews-invalidated', revision: 6 },
			{ type: 'pull-request-reviews-invalidated', revision: -1 },
			{ type: 'pull-request-reviews-invalidated', revision: 7, extra: true },
			{ type: 'scheduled-prompts-invalidated', reason: 'executed' },
			{ type: 'snippets-invalidated', reason: 'updated' },
			{ type: 'snippets-invalidated', reason: 'unknown' },
			{ type: 'tickets-invalidated', revision: 4 },
			{ type: 'tickets-invalidated', revision: -1 },
			{ type: 'tickets-invalidated', revision: 5, content: 'unexpected body' },
			{ type: 'settings-changed', settings: snapshot },
			{ type: 'settings-changed', settings: {} },
			{ type: 'transcript-search-status', status: {} },
		];
		try {
			fixture.send({ type: 'chat-messages', chatId: '1700000000000001', messages: [] });
			for (const frame of frames) fixture.send(frame);
			fixture.send({ type: 'unknown-event' });

			expect(parsed).toHaveBeenCalledTimes(frames.length);
			expect(targets.apiProviders.invalidate).toHaveBeenCalledOnce();
			expect(targets.chatBoardInvalidations.publish).toHaveBeenCalledExactlyOnceWith({
				kind: 'catalog',
				revision: 7,
				reason: 'reordered',
			});
			expect(targets.executors.executors).toEqual([localExecutor, remoteExecutor]);
			expect(targets.preambles.refreshIfLoaded).toHaveBeenCalledOnce();
			expect(targets.preambleSelections.publish).toHaveBeenCalledExactlyOnceWith({
				kind: 'selection',
				chatId: '1700000000000001',
				revision: 3,
			});
			expect(targets.pullRequestReviews.invalidate).toHaveBeenCalledExactlyOnceWith(6);
			expect(targets.remoteSettings.applySnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
			expect(targets.scheduledPrompts.refreshIfLoaded).toHaveBeenCalledOnce();
			expect(targets.snippets.refreshIfLoaded).toHaveBeenCalledOnce();
			expect(receivedTicket).toHaveBeenCalledExactlyOnceWith({ kind: 'collection', revision: 4 });
			ticketsInvalidations.publishReconnect();
			expect(receivedTicket).toHaveBeenLastCalledWith({ kind: 'reconnect' });
			expect(onStatus).not.toHaveBeenCalled();
			expect(cursor.drain().map(({ data }) => data.type)).toEqual([
				'chat-messages',
				...frames.map(({ type }) => type),
				'unknown-event',
			]);
			expect(cursor.drain()).toEqual([]);

			unsubscribe();
			fixture.send({ type: 'snippets-invalidated', reason: 'updated' });
			expect(targets.snippets.refreshIfLoaded).toHaveBeenCalledOnce();
		} finally {
			unsubscribe();
			unsubscribeTicket();
			cursor.cleanup();
			status.destroy();
			fixture.close();
			parsed.mockRestore();
		}
	});
});

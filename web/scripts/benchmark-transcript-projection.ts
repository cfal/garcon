import { AssistantMessage, ReadToolUseMessage, ToolResultMessage, type ChatMessage } from '../../common/chat-types.js';
import { ConversationFeedProjectionState, type ConversationFeedProjectionInput } from '../src/lib/components/chat/transcript/ConversationFeedProjectionState.svelte.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const runs = Number(process.env.GARCON_PROFILE_RUNS ?? 40);
const sizes = (process.env.GARCON_PROFILE_SIZES ?? '1000,3000,10000,30000').split(',').map(Number);

function row(index: number): ConversationFeedProjectionInput['rows'][number] {
	const toolId = `tool-${Math.floor(index / 3)}`;
	let message: ChatMessage;
	switch (index % 3) {
		case 0:
			message = new ReadToolUseMessage(timestamp, toolId, '/synthetic');
			break;
		case 1:
			message = new ToolResultMessage(timestamp, toolId, { raw: 'synthetic' }, false);
			break;
		default:
			message = new AssistantMessage(timestamp, 'Synthetic response');
	}
	return {
		kind: 'message', id: `synthetic:${index}`, ordinal: index + 1,
		message,
	};
}

function profile(size: number, combined: boolean) {
	const controller = new ConversationFeedProjectionState();
	let input: ConversationFeedProjectionInput = {
		surfaceIdentity: 'synthetic', transcriptViewId: 'synthetic',
		rows: Array.from({ length: size }, (_, index) => row(index)),
		mutationClock: { dataRevision: 1, lastResponseRevisionByMessageType: {}, lastRevisionByKind: {
			initial: 1, 'live-append': 0, 'history-earlier': 0, 'history-later': 0,
			replacement: 0, 'presentation-structure': 0,
		} },
		hiddenToolTypes: [], hiddenBashCommands: null, showThinking: true,
		isLiveWindow: true, showRefreshError: false, earlierBoundary: 'hidden',
		showLaterBoundary: false, reserveComposerCapSpace: false, pendingPermissions: [],
		combineToolUseMessages: combined, expandedToolMemberIds: new Set(), protectedVirtualKeys: [],
	};
	const start = performance.now();
	controller.reconcile(input);
	const coldMs = performance.now() - start;
	const samples = [];
	for (let index = 0; index < runs; index++) {
		input = { ...input, rows: [...input.rows, row(size + index)], mutationClock: {
			...input.mutationClock, dataRevision: index + 2,
			lastRevisionByKind: { ...input.mutationClock.lastRevisionByKind, 'live-append': index + 2 },
		} };
		const started = performance.now();
		controller.reconcile(input);
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return { rows: size, combined, runs, coldMs, p50: samples[Math.floor(runs * 0.5)], p95: samples[Math.floor(runs * 0.95)] };
}

console.log(JSON.stringify({ engine: `Bun ${Bun.version}`, scope: 'Projection only; excludes DOM, layout and ingestion',
	results: sizes.flatMap(size => [profile(size, false), profile(size, true)]),
}, null, 2));

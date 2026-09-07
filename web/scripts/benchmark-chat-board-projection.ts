import { projectChatBoard } from '../src/lib/chat-board/projection/chat-board-projection.js';
import type { ChatSessionRecord } from '../src/lib/types/chat-session.js';
import type { ChatBoard } from '../../common/chat-boards.js';

const CHAT_COUNT = 5_000;
const COLUMN_COUNT = 20;
const TAGS_PER_RULE = 32;
const RUN_COUNT = 40;

const tagPool = Array.from(
	{ length: 128 },
	(_, index) => `tag-${index.toString().padStart(3, '0')}`,
);
const board: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Benchmark',
	columns: Array.from({ length: COLUMN_COUNT }, (_, columnIndex) => ({
		id: `${(columnIndex + 2).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`,
		name: `Column ${columnIndex + 1}`,
		match: columnIndex % 2 === 0 ? ('all' as const) : ('any' as const),
		tags: Array.from(
			{ length: TAGS_PER_RULE },
			(_, tagIndex) => tagPool[(columnIndex * 5 + tagIndex) % tagPool.length],
		).sort(),
	})),
};

const chats: ChatSessionRecord[] = Array.from({ length: CHAT_COUNT }, (_, chatIndex) => ({
	id: `chat-${chatIndex}`,
	parentChat: null,
	projectPath: `/workspace/project-${chatIndex % 25}`,
	orderGroup: 'normal',
	title: `Chat ${chatIndex}`,
	agentId: 'claude',
	model: 'sonnet',
	permissionMode: 'default',
	thinkingMode: 'none',
	agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
	createdAt: null,
	lastActivityAt: null,
	lastReadAt: null,
	isPinned: false,
	isArchived: false,
	isProcessing: chatIndex % 13 === 0,
	processingPhase: null,
	canReloadFromNativeHistory: false,
	isUnread: false,
	status: 'running',
	agentOwnershipEpoch: null,
	tags: Array.from(
		{ length: 40 },
		(_, offset) => tagPool[(chatIndex * 7 + offset) % tagPool.length],
	).sort(),
}));

function measure(): number {
	const started = performance.now();
	projectChatBoard(board, chats);
	return performance.now() - started;
}

const coldMs = measure();
const samples = Array.from({ length: RUN_COUNT }, measure).sort((left, right) => left - right);
const medianMs = samples[Math.floor(samples.length / 2)];
const p95Ms = samples[Math.floor(samples.length * 0.95)];

console.log(
	JSON.stringify(
		{
			fixture: { chats: CHAT_COUNT, columns: COLUMN_COUNT, tagsPerRule: TAGS_PER_RULE },
			coldMs: Number(coldMs.toFixed(2)),
			medianMs: Number(medianMs.toFixed(2)),
			p95Ms: Number(p95Ms.toFixed(2)),
		},
		null,
		2,
	),
);

if (coldMs > 250 || p95Ms > 250) {
	throw new Error(`Chat Board projection exceeded the 250ms guard (cold=${coldMs}, p95=${p95Ms})`);
}

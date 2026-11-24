import type { ChatSessionRecord } from '../src/lib/chat/sessions/chat-session-types.js';
import {
	buildSidebarChatOrderMap,
	buildSidebarChatListProjection,
	buildSidebarRowModel,
} from '../src/lib/sidebar/display/sidebar-row-model.js';
import { matchesChatFilter, parseChatSearch } from '../../common/chat-filter-query.js';

const SIZES = [200, 500, 2_000];
const SAMPLES = Number(process.env.GARCON_PROFILE_SAMPLES ?? 7);
const FIXTURE_SEED = Number(process.env.GARCON_PROFILE_SEED ?? 7_312_026);
const CURRENT_TIME = new Date('2026-09-06T12:00:00.000Z');
const ACTIVE_SEARCH = parseChatSearch('agent:claude tag:perf');
let resultGuard = 0;

interface Metric {
	p50Ms: number;
	p95Ms: number;
	samplesMs: number[];
}

function percentile(values: readonly number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function randomGenerator(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value += 0x6d2b79f5;
		let mixed = value;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function fixture(size: number, nestedProjects: boolean): ChatSessionRecord[] {
	const random = randomGenerator(FIXTURE_SEED + size + Number(nestedProjects));
	const projectCount = Math.max(4, Math.floor(size / 10));
	return Array.from({ length: size }, (_, index) => {
		const project = index % projectCount;
		const projectVisit = Math.floor(index / projectCount);
		const projectPath = nestedProjects
			? project % 2 === 0
				? `/workspace/project-${Math.floor(project / 2)}`
				: `/workspace/project-${Math.floor(project / 2)}/package-${project}`
			: `/workspace/project-${project}`;
		const activityOffsetMinutes = Math.floor(random() * 60 * 24 * 30);
		const lastActivityAt = new Date(
			CURRENT_TIME.getTime() - activityOffsetMinutes * 60_000,
		).toISOString();
		const isPinned = index % 13 === 0;
		const isArchived = !isPinned && index % 11 === 0;
		return {
			id: `chat-${index}`,
			parentChatId: null,
			lineage: null,
			projectPath,
			effectiveProjectKey: projectPath,
			projectIdentityState: 'available',
			orderGroup: isPinned ? 'pinned' : isArchived ? 'archived' : 'normal',
			title: `Chat ${index} performance fixture`,
			agentId: projectVisit % 5 === 0 ? 'codex' : 'claude',
			model: projectVisit % 5 === 0 ? 'gpt-5' : 'sonnet',
			permissionMode: 'default',
			thinkingMode: 'low',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			createdAt: lastActivityAt,
			lastActivityAt,
			lastReadAt: index % 7 === 0 ? null : lastActivityAt,
			isPinned,
			isArchived,
			isProcessing: index % 17 === 0,
			processingPhase: index % 17 === 0 ? 'running' : null,
			canReloadFromNativeHistory: false,
			observation: null,
			isUnread: index % 7 === 0,
			status: 'running',
			agentOwnershipEpoch: null,
			lastMessage: `Deterministic message ${index}`,
			tags: projectVisit % 3 === 0 ? ['perf'] : ['general'],
		};
	});
}

function profile(operation: () => number, iterations: number): Metric {
	operation();
	const samples = Array.from({ length: SAMPLES }, () => {
		Bun.gc(true);
		const startedAt = performance.now();
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			resultGuard += operation();
		}
		return (performance.now() - startedAt) / iterations;
	});
	return {
		p50Ms: percentile(samples, 0.5),
		p95Ms: percentile(samples, 0.95),
		samplesMs: samples,
	};
}

function scenario(
	size: number,
	nestedProjects: boolean,
	activeSearch: boolean,
	shape: 'flat' | 'forest' | 'chain',
) {
	const chats = fixture(size, nestedProjects);
	const displayedChats = activeSearch
		? chats.filter((chat) => matchesChatFilter(chat, ACTIVE_SEARCH))
		: chats;

	if (shape !== 'flat') {
		chats.forEach((chat, index) => {
			if (index > 0 && (shape === 'chain' || index % 8 !== 0)) {
				chat.parentChatId = chats[shape === 'chain' ? index - 1 : index - (index % 8)].id;
			}
		});
	}
	const iterations = Math.max(3, Math.floor(10_000 / size));
	const projectionInput = {
		allChats: chats,
		matchingChatIds: activeSearch ? new Set(displayedChats.map((chat) => chat.id)) : undefined,
		groupingFields: (['executor', 'project', 'activity', 'status'] as const).map((field) => ({
			field,
			enabled: true,
		})),
		nestDelegatedChats: shape !== 'flat',
		currentTime: CURRENT_TIME,
		inactivityDuration: '3-days' as const,
		sortMode: 'recent' as const,
		pinnedInsertPosition: 'top' as const,
		groupNestedProjectPaths: nestedProjects,
	};
	const rowInput = { ...projectionInput, orders: buildSidebarChatOrderMap(chats) };
	const shared = buildSidebarChatListProjection(projectionInput);
	if (new Set(shared.rowModel.visibleChatIds).size !== shared.rowModel.visibleChatIds.length) {
		throw new Error('Projection duplicated a chat.');
	}

	return {
		size,
		nestedProjects,
		activeSearch,
		matchedChats: displayedChats.length,
		shape,
		rows: shared.rowModel.rows.length,
		iterations,
		filter: profile(
			() =>
				(activeSearch ? chats.filter((chat) => matchesChatFilter(chat, ACTIVE_SEARCH)) : chats)
					.length,
			iterations,
		),
		sharedProjection: profile(
			() => buildSidebarChatListProjection(projectionInput).rowModel.rows.length,
			iterations,
		),
		collapsedProjection: profile(
			() =>
				buildSidebarChatListProjection({
					...projectionInput,
					collapsedProjectKeys: new Set(
						chats.filter((chat) => !chat.parentChatId).map((chat) => 'delegation:' + chat.id),
					),
				}).rowModel.rows.length,
			iterations,
		),
		rowModel: profile(() => buildSidebarRowModel(rowInput).rows.length, iterations),
	};
}

const scenarios = SIZES.flatMap((size) =>
	[false, true].flatMap((nestedProjects) =>
		[false, true].flatMap((activeSearch) =>
			(['flat', 'forest', 'chain'] as const).map((shape) =>
				scenario(size, nestedProjects, activeSearch, shape),
			),
		),
	),
);

console.log(
	JSON.stringify(
		{
			seed: FIXTURE_SEED,
			samples: SAMPLES,
			scenarios,
			resultGuard,
		},
		null,
		2,
	),
);

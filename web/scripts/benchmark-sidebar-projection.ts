import type { ChatSessionRecord } from '../src/lib/types/chat-session.js';
import {
	buildSidebarChatOrderMap,
	buildSidebarDisplayChatIds,
	buildSidebarProjectKeys,
	buildSidebarRowModel,
	partitionSidebarChats,
} from '../src/lib/components/sidebar/sidebar-row-model.js';
import { sortChatsByRecencyDesc } from '../src/lib/components/sidebar/chat-recency-sort.js';
import { matchesChatFilter, parseChatSearch } from '../src/lib/sidebar/search/sidebar-search.js';

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
			parentChat: null,
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

function scenario(size: number, nestedProjects: boolean, activeSearch: boolean) {
	const chats = fixture(size, nestedProjects);
	const displayedChats = activeSearch
		? chats.filter((chat) => matchesChatFilter(chat, ACTIVE_SEARCH))
		: chats;
	const sortedChats = sortChatsByRecencyDesc(displayedChats);
	const orders = buildSidebarChatOrderMap(sortedChats);
	const iterations = Math.max(5, Math.floor(20_000 / size));
	const ungroupedProjectCount = buildSidebarProjectKeys({
		displayedChats,
		groupNestedProjectPaths: false,
	}).length;
	const groupedProjectCount = buildSidebarProjectKeys({
		displayedChats,
		groupNestedProjectPaths: true,
	}).length;
	if (nestedProjects && groupedProjectCount >= ungroupedProjectCount) {
		throw new Error(
			`Nested fixture did not reduce project keys: ${ungroupedProjectCount} -> ${groupedProjectCount}`,
		);
	}
	const rowInput = {
		displayedChats: sortedChats,
		orders,
		grouping: 'project-and-activity' as const,
		currentTime: CURRENT_TIME,
		inactivityDuration: '3-days' as const,
		groupNestedProjectPaths: nestedProjects,
		collapsedProjectKeys: new Set<string>(),
	};

	return {
		size,
		nestedProjects,
		activeSearch,
		matchedChats: displayedChats.length,
		ungroupedProjectCount,
		groupedProjectCount,
		iterations,
		filter: profile(
			() =>
				(activeSearch
					? chats.filter((chat) => matchesChatFilter(chat, ACTIVE_SEARCH))
					: chats
				).length,
			iterations,
		),
		sort: profile(() => sortChatsByRecencyDesc(displayedChats).length, iterations),
		partition: profile(
			() => partitionSidebarChats(displayedChats).byId.normal.size,
			iterations,
		),
		projectKeys: profile(
			() =>
				buildSidebarProjectKeys({
					displayedChats,
					groupNestedProjectPaths: nestedProjects,
				}).length,
			iterations,
		),
		displayIds: profile(
			() =>
				buildSidebarDisplayChatIds({
					displayedChats,
					grouping: 'project-and-activity',
					currentTime: CURRENT_TIME,
					inactivityDuration: '3-days',
					sortMode: 'recent',
					groupNestedProjectPaths: nestedProjects,
				}).length,
			iterations,
		),
		rowModel: profile(() => buildSidebarRowModel(rowInput).rows.length, iterations),
	};
}

const scenarios = SIZES.flatMap((size) =>
	[false, true].flatMap((nestedProjects) =>
		[false, true].map((activeSearch) => scenario(size, nestedProjects, activeSearch)),
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

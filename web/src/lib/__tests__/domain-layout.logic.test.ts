import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const expectedConcerns = {
	chat: [
		'actions',
		'composer',
		'conversation',
		'file-links',
		'new-chat',
		'sessions',
		'tools',
		'transcript',
	],
	git: ['commit', 'history', 'pull-requests', 'review', 'surface', 'targets', 'workbench'],
	files: ['documents', 'editor', 'navigation', 'persistence', 'sessions', 'surface', 'tree'],
	terminal: ['runtime', 'sessions'],
	sidebar: ['projects', 'search'],
} as const;

const componentConcerns = [
	{
		owner: 'chat',
		concern: 'composer',
		filePrefixes: ['Composer', 'PromptComposer', 'composer-', 'prompt-composer-'],
	},
	{
		owner: 'chat',
		concern: 'queue',
		filePrefixes: ['QueuedInput', 'QueueControls', 'QueueStatusSummary', 'queued-input-'],
	},
	{
		owner: 'chat',
		concern: 'new-chat',
		filePrefixes: ['NewChat', 'new-chat-'],
	},
	{
		owner: 'chat',
		concern: 'transcript',
		filePrefixes: [
			'ConversationFeed',
			'ConversationMessage',
			'ConversationTranscript',
			'ConversationToolGroup',
			'conversation-feed-',
		],
	},
	{
		owner: 'sidebar',
		concern: 'search',
		filePrefixes: ['SidebarSearch', 'SidebarTranscriptSearchStatus', 'SavedSearch', 'sidebar-search-'],
	},
] as const;

describe('domain layout', () => {
	for (const [domain, concerns] of Object.entries(expectedConcerns)) {
		it(`keeps ${domain} modules in approved concerns`, () => {
			const entries = readdirSync(join(process.cwd(), 'src/lib', domain), {
				withFileTypes: true,
			});
			const allowed = new Set<string>([...concerns, '__tests__']);
			const expected = new Set<string>(concerns);
			const unexpected = entries
				.filter((entry) => !allowed.has(entry.name) || !entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
			const actualConcerns = entries
				.filter((entry) => entry.isDirectory() && expected.has(entry.name))
				.map((entry) => entry.name)
				.sort();

			expect(unexpected, `${domain} has unexpected top-level entries`).toEqual([]);
			expect(actualConcerns, `${domain} is missing an approved concern`).toEqual(
				[...concerns].sort(),
			);
		});
	}
});

describe('component concerns', () => {
	for (const { owner, concern, filePrefixes } of componentConcerns) {
		it(`keeps ${owner} ${concern} components and private helpers together`, () => {
			const directory = join(process.cwd(), 'src/lib/components', owner);
			const entries = readdirSync(directory, { withFileTypes: true });
			expect(entries.some((entry) => entry.isDirectory() && entry.name === concern)).toBe(true);
			const misplaced = entries
				.filter(
					(entry) => entry.isFile() && filePrefixes.some((prefix) => entry.name.startsWith(prefix)),
				)
				.map((entry) => entry.name);
			expect(misplaced, `${owner}/${concern} files must not return to the component root`).toEqual(
				[],
			);
			expect(readdirSync(join(directory, concern))).toContain('__tests__');
		});
	}
});

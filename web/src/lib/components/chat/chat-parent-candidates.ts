import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import { parseChatId } from '$shared/chat-id';

export type ParentCandidate = Pick<
	ChatSessionRecord,
	'id' | 'title' | 'status' | 'parentChat' | 'lastActivityAt' | 'executorId' | 'projectPath'
>;

export function eligibleParentChats<T extends ParentCandidate>(
	chats: readonly T[],
	childId: string,
): T[] {
	const children = new Map<string, string[]>();
	for (const chat of chats) {
		const parent = chat.parentChat?.chatId;
		if (!parent) continue;
		const siblings = children.get(parent) ?? [];
		siblings.push(chat.id);
		children.set(parent, siblings);
	}
	const excluded = new Set<string>();
	const pending = [childId];
	while (pending.length) {
		const id = pending.pop()!;
		if (excluded.has(id)) continue;
		excluded.add(id);
		for (const child of children.get(id) ?? []) pending.push(child);
	}
	return chats.filter((chat) => chat.status !== 'draft' && !excluded.has(chat.id));
}

export function matchParentChats<T extends ParentCandidate>(
	chats: readonly T[],
	query: string,
): T[] {
	const text = query.trim().toLowerCase();
	const rank = (chat: T): number => {
		const title = chat.title.toLowerCase();
		if (text && chat.id === text) return 0;
		if (chat.id.startsWith(text) || title.startsWith(text)) return 1;
		return title.includes(text) || chat.id.includes(text) ? 2 : 3;
	};
	return chats
		.map((chat) => ({ chat, rank: rank(chat) }))
		.filter((entry) => entry.rank < 3)
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				(b.chat.lastActivityAt ?? '').localeCompare(a.chat.lastActivityAt ?? '') ||
				b.chat.id.localeCompare(a.chat.id),
		)
		.slice(0, 20)
		.map(({ chat }) => chat);
}

export function typedParentId(query: string): string | undefined {
	try {
		return parseChatId(query.trim());
	} catch {
		return undefined;
	}
}

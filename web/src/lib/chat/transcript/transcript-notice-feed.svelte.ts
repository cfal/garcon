import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { createRandomId } from '$lib/utils/random-id';

const SERVER_NOTICE_RETENTION_LIMIT = 8;

// Overlay notices for the active conversation plus a bounded per-chat buffer
// of server-issued notices addressed to background chats. Rows carry a
// monotonic revision so live appends can clear exactly the notices that
// preceded them; the buffer drains into the feed when its chat activates.
export class TranscriptNoticeFeed {
	rows = $state<(LocalNoticeRow & { revision: number })[]>([]);
	#revision = 0;
	#revisionAtLoadStart = 0;
	#retainedByChat = new Map<string, LocalNoticeRow[]>();

	get revision(): number {
		return this.#revision;
	}

	get revisionAtLoadStart(): number {
		return this.#revisionAtLoadStart;
	}

	markLoadStart(): void {
		this.#revisionAtLoadStart = this.#revision;
	}

	append(noticeType: LocalNoticeType, content: string): void {
		this.rows = [...this.rows, { ...this.#row('local', noticeType, content), revision: ++this.#revision }];
	}

	retain(chatId: string, noticeType: LocalNoticeType, content: string): void {
		const retained = this.#retainedByChat.get(chatId) ?? [];
		retained.push(this.#row('server', noticeType, content));
		if (retained.length > SERVER_NOTICE_RETENTION_LIMIT) retained.shift();
		this.#retainedByChat.set(chatId, retained);
	}

	discard(chatId: string): void {
		this.#retainedByChat.delete(chatId);
	}

	drain(chatId: string): boolean {
		const retained = this.#retainedByChat.get(chatId);
		if (!retained?.length) return false;
		this.#retainedByChat.delete(chatId);
		this.rows = [
			...this.rows,
			...retained.map((notice) => ({ ...notice, revision: ++this.#revision })),
		];
		return true;
	}

	clearThrough(revision = this.#revision): boolean {
		const next = this.rows.filter((notice) => notice.revision > revision);
		if (next.length === this.rows.length) return false;
		this.rows = next;
		return true;
	}

	reset(): void {
		this.rows = [];
	}

	#row(idPrefix: string, noticeType: LocalNoticeType, content: string): LocalNoticeRow {
		return {
			kind: 'local-notice',
			id: `${idPrefix}_${createRandomId()}`,
			noticeType,
			content,
			timestamp: new Date().toISOString(),
		};
	}
}

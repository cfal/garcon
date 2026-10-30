// Declares to the server which chats' transcript bodies this browser socket
// displays. Every other chat arrives as a body-free summary.

import { untrack } from 'svelte';
import {
	ChatTranscriptInterestRequest,
	MAX_TRANSCRIPT_INTEREST_CHAT_IDS,
} from '$shared/ws-requests';
import type { PrimaryWsConnectionPort } from './connection.svelte.js';

export type TranscriptInterestConnectionPort = Pick<
	PrimaryWsConnectionPort,
	'isConnected' | 'sendMessage' | 'onConnectionChange'
>;

export class ChatTranscriptInterestController {
	#chatIds: readonly string[] = [];
	// The set the current socket last accepted; null until this socket has one.
	#declaredKey: string | null = null;

	constructor(private readonly connection: TranscriptInterestConnectionPort) {}

	get chatIds(): readonly string[] {
		return this.#chatIds;
	}

	// Each declaration replaces the whole set, so ordering across rapid
	// switches needs no acknowledgement: the socket's last frame wins.
	update(chatIds: readonly string[]): void {
		this.#chatIds = [...new Set(chatIds)].sort().slice(0, MAX_TRANSCRIPT_INTEREST_CHAT_IDS);
		this.#declare();
	}

	// Pre-effects declare before reconciliation starts loading newly displayed
	// chats. A new socket re-declares from its open listener, ahead of any
	// replay request the reconnect coordinator sends on it.
	mount(getChatIds: () => readonly string[]): void {
		$effect(() =>
			this.connection.onConnectionChange((connected) => {
				this.#declaredKey = null;
				if (connected) this.#declare();
			}),
		);
		$effect.pre(() => {
			const chatIds = getChatIds();
			untrack(() => this.update(chatIds));
		});
		$effect(() => () => this.update([]));
	}

	#declare(): void {
		if (!this.connection.isConnected) return;
		const key = this.#chatIds.join('\u0000');
		if (key === this.#declaredKey) return;
		// A new socket already starts with no interest.
		if (key === '' && this.#declaredKey === null) {
			this.#declaredKey = key;
			return;
		}
		if (this.connection.sendMessage(new ChatTranscriptInterestRequest([...this.#chatIds]))) {
			this.#declaredKey = key;
		}
	}
}

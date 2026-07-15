// Listens for settings-changed WebSocket messages and applies the
// snapshot to the RemoteSettingsStore. Creates its own drain cursor
// so it operates independently of the main event router.

import type { WsConnection } from '$lib/ws/connection.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { parseServerWsMessage, SettingsChangedMessage } from '$shared/ws-events';

export class RemoteSettingsRouter {
	readonly #remoteSettings: RemoteSettingsStore;
	readonly #ws: WsConnection;
	#handle: DrainHandle | null = null;

	constructor(ws: WsConnection, remoteSettings: RemoteSettingsStore) {
		this.#ws = ws;
		this.#remoteSettings = remoteSettings;
	}

	start(): void {
		if (this.#handle) return;
		this.#handle = createDrainCursor(this.#ws);
	}

	/** Drains pending messages and applies any settings-changed snapshot.
	 *  Call this from an $effect that reads ws.messageVersion. */
	tick(): void {
		if (!this.#handle) return;
		const messages = this.#handle.drain();
		for (const msg of messages) {
			const parsed = parseServerWsMessage(msg.data);
			if (parsed instanceof SettingsChangedMessage) {
				this.#remoteSettings.applySnapshot(parsed.settings);
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}

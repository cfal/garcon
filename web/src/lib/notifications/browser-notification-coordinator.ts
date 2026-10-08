const CHANNEL_NAME = 'garcon-browser-notifications';
const FOCUS_PROBE_MS = 75;

interface PeerReply {
	readonly type: 'reply';
	readonly requestId: string;
	readonly peerId: string;
	readonly focused: boolean;
	readonly seen: boolean;
	readonly eligible: boolean;
}

interface FocusProbeMessage {
	readonly type: 'probe';
	readonly requestId: string;
	readonly tag: string;
}

interface Probe {
	readonly replies: PeerReply[];
	finish(): void;
}

/** Coordinates generic notification receipts and fresh focus checks across open tabs. */
export class BrowserNotificationCoordinator {
	readonly #peerId = crypto.randomUUID();
	readonly #channel: BroadcastChannel | null;
	readonly #seen = new Set<string>();
	readonly #probes = new Map<string, Probe>();
	#destroyed = false;

	constructor(private readonly deps: { isFocused(): boolean; eligible(): boolean }) {
		try {
			this.#channel = new BroadcastChannel(CHANNEL_NAME);
			this.#channel.onmessage = (event: MessageEvent) => this.#receive(event.data);
		} catch {
			this.#channel = null;
		}
	}

	#receive(value: unknown): void {
		if (this.#destroyed || !value || typeof value !== 'object') return;
		const message = value as Record<string, unknown>;
		if (typeof message.requestId !== 'string') return;
		if (message.type === 'probe' && typeof message.tag === 'string') {
			this.#channel?.postMessage({
				type: 'reply',
				requestId: message.requestId,
				peerId: this.#peerId,
				focused: this.deps.isFocused(),
				seen: this.#seen.has(message.tag),
				eligible: this.deps.eligible(),
			} satisfies PeerReply);
		} else if (
			message.type === 'reply' &&
			typeof message.peerId === 'string' &&
			typeof message.focused === 'boolean' &&
			typeof message.seen === 'boolean' &&
			typeof message.eligible === 'boolean'
		) {
			this.#probes.get(message.requestId)?.replies.push({
				type: 'reply',
				requestId: message.requestId,
				peerId: message.peerId,
				focused: message.focused,
				seen: message.seen,
				eligible: message.eligible,
			});
		}
	}

	async run(tag: string, deliver: () => Promise<void>): Promise<void> {
		const locks = navigator.locks;
		const attempt = async () => {
			if (this.#destroyed || this.#seen.has(tag) || !this.deps.eligible() || this.deps.isFocused())
				return;
			const replies = await this.#probe(tag);
			if (
				this.#destroyed ||
				!this.deps.eligible() ||
				this.deps.isFocused() ||
				replies.some((reply) => reply.focused || reply.seen)
			)
				return;
			// Browsers without Web Locks elect one eligible peer instead of racing delivery.
			if (!locks && replies.some((reply) => reply.eligible && reply.peerId < this.#peerId)) return;
			this.#seen.add(tag);
			while (this.#seen.size > 256) this.#seen.delete(this.#seen.values().next().value!);
			await deliver();
		};
		if (locks) await locks.request(CHANNEL_NAME, attempt);
		else await attempt();
	}

	#probe(tag: string): Promise<PeerReply[]> {
		if (!this.#channel) return Promise.resolve([]);
		const requestId = crypto.randomUUID();
		return new Promise((resolve) => {
			const replies: PeerReply[] = [];
			const timer = setTimeout(() => finish(), FOCUS_PROBE_MS);
			const finish = () => {
				clearTimeout(timer);
				this.#probes.delete(requestId);
				resolve(replies);
			};
			this.#probes.set(requestId, { replies, finish });
			this.#channel!.postMessage({ type: 'probe', requestId, tag } satisfies FocusProbeMessage);
		});
	}

	destroy(): void {
		this.#destroyed = true;
		for (const probe of this.#probes.values()) probe.finish();
		this.#channel?.close();
		this.#seen.clear();
	}
}

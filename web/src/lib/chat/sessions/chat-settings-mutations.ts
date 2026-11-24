import type { ChatSessionRecord } from './chat-session-types.js';
import type { ChatSessionsPort } from './chat-sessions-contract.js';

export type ChatSettingsPatch = Partial<
	Pick<
		ChatSessionRecord,
		| 'model'
		| 'apiProviderId'
		| 'modelEndpointId'
		| 'modelProtocol'
		| 'permissionMode'
		| 'thinkingMode'
		| 'agentSettings'
	>
>;
export type ChatSetting = 'model' | 'permissionMode' | 'thinkingMode' | 'agentSettings';

interface SettingMutation {
	epoch: string | undefined;
	confirmed: ChatSettingsPatch;
	latest: symbol;
}

function readPatch(chat: ChatSessionRecord, fields: ChatSettingsPatch): ChatSettingsPatch {
	return Object.fromEntries(
		Object.keys(fields).map((key) => [key, chat[key as keyof ChatSettingsPatch]]),
	);
}

/** Owns outstanding settings writes by chat, independently of the mounted composer. */
export class ChatSettingsMutations {
	#mutations = new Map<string, SettingMutation>();
	#requests = new Map<string, Promise<boolean>>();

	pendingFor(chatId: string): Promise<boolean> | null {
		return this.#requests.has(chatId) ? this.#settle(chatId) : null;
	}

	async #settle(chatId: string): Promise<boolean> {
		let accepted = true;
		while (true) {
			const pending = this.#requests.get(chatId);
			if (!pending) return accepted;
			accepted = await pending;
		}
	}

	change(
		chatId: string,
		setting: ChatSetting,
		patch: ChatSettingsPatch,
		options: {
			sessions: Pick<ChatSessionsPort, 'byId' | 'quietRefreshChats'>;
			request: (epoch: string | undefined) => Promise<ChatSettingsPatch>;
			apply: (patch: ChatSettingsPatch) => void;
			onFailure: (error: unknown) => void;
		},
	): void {
		const { sessions, request, apply, onFailure } = options;
		const chat = sessions.byId[chatId];
		if (!chat) return;
		const key = `${chatId}:${setting}`;
		const epoch = chat.agentOwnershipEpoch ?? undefined;
		const previous = this.#mutations.get(key);
		const token = Symbol(key);
		const mutation =
			previous && previous.epoch === epoch
				? previous
				: { epoch, confirmed: readPatch(chat, patch), latest: token };
		mutation.latest = token;
		this.#mutations.set(key, mutation);
		const isLatest = () => this.#mutations.get(key) === mutation && mutation.latest === token;
		const isCurrent = () =>
			isLatest() && !!sessions.byId[chatId] && sessions.byId[chatId].agentOwnershipEpoch === epoch;
		apply(patch);

		const run = async () => {
			try {
				// Superseded successes still advance the rollback baseline for the next request.
				mutation.confirmed = await request(epoch);
				if (isCurrent()) apply(mutation.confirmed);
				return true;
			} catch (error) {
				if (isCurrent()) {
					apply(mutation.confirmed);
					onFailure(error);
				}
				return false;
			} finally {
				try {
					if (isCurrent()) {
						// A lost reply may follow a durable write, so rollback alone is not authority.
						await sessions.quietRefreshChats();
						if (isCurrent()) apply(readPatch(sessions.byId[chatId], patch));
					}
				} finally {
					if (isLatest()) this.#mutations.delete(key);
				}
			}
		};
		const previousRequest = this.#requests.get(chatId);
		const pending = (previousRequest ? previousRequest.then(run) : run()).catch(() => false);
		this.#requests.set(chatId, pending);
		void pending.then(() => {
			if (this.#requests.get(chatId) === pending) this.#requests.delete(chatId);
		});
	}
}

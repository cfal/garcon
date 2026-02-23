// Composer state: input text, image attachments, draft persistence,
// and message submission. Manages the input area lifecycle for a single chat.

import type { WsConnection } from '$lib/ws/connection.svelte';
import { AgentRunRequest } from '$shared/ws-requests';

const DRAFT_PREFIX = 'chat_draft_';

export class ComposerState {
	inputText = $state('');
	images = $state<File[]>([]);
	isSubmitting = $state(false);
	isDragActive = $state(false);

	/** Saves the current input text as a draft keyed by chat ID. */
	saveDraft(chatId: string): void {
		if (!chatId) return;
		const key = `${DRAFT_PREFIX}${chatId}`;
		try {
			if (this.inputText.trim()) {
				localStorage.setItem(key, this.inputText);
			} else {
				localStorage.removeItem(key);
			}
		} catch {
			// Storage full or unavailable
		}
	}

	/** Restores a previously saved draft for the given chat ID. */
	restoreDraft(chatId: string): void {
		this.inputText = '';
		this.clearImages();
		if (!chatId) return;
		const key = `${DRAFT_PREFIX}${chatId}`;
		try {
			const saved = localStorage.getItem(key);
			if (saved) {
				this.inputText = saved;
			}
		} catch {
			// Ignore read errors
		}
	}

	/** Removes the saved draft for the given chat ID. */
	clearDraft(chatId: string): void {
		if (!chatId) return;
		const key = `${DRAFT_PREFIX}${chatId}`;
		try {
			localStorage.removeItem(key);
		} catch {
			// Ignore removal errors
		}
	}

	/** Adds image files, filtering out duplicates by name. */
	addImages(files: File[]): void {
		const existingNames = new Set(this.images.map((f) => f.name));
		const newFiles = files.filter((f) => !existingNames.has(f.name));
		this.images = [...this.images, ...newFiles];
	}

	/** Removes an image at the given index. */
	removeImage(index: number): void {
		this.images = this.images.filter((_, i) => i !== index);
	}

	/** Clears all attached images. */
	clearImages(): void {
		this.images = [];
	}

	/** Resets input text, images, and draft for the given chat. */
	clearAfterSubmit(chatId: string): void {
		this.inputText = '';
		this.images = [];
		this.clearDraft(chatId);
	}

	/**
	 * Submits the current message via WebSocket. Sends as an agent-run
	 * with the current text and optional image attachments.
	 */
	async submitMessage(
		ws: WsConnection,
		chatId: string,
		options: {
			provider: string;
			model: string;
			permissionMode: string;
			projectPath: string;
			isNewChat: boolean;
			thinkingMode?: string;
		}
	): Promise<boolean> {
		const text = this.inputText.trim();
		if (!text && this.images.length === 0) return false;

		this.isSubmitting = true;

		// Clear immediately for synchronous DOM update,
		// preventing Safari IME composition race conditions.
		const previousText = this.inputText;
		const previousImages = [...this.images];
		this.clearAfterSubmit(chatId);

		try {
			// Convert images to base64 data URLs for transmission.
			const imageData = await Promise.all(
				previousImages.map(async (file) => {
					const buffer = await file.arrayBuffer();
					const base64 = btoa(
						new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
					);
					return {
						data: `data:${file.type};base64,${base64}`,
						name: file.name
					};
				})
			);

			const sent = ws.sendMessage(new AgentRunRequest(
				chatId,
				options.provider,
				text,
				options.isNewChat,
				{
					cwd: options.projectPath,
					projectPath: options.projectPath,
					sessionId: chatId,
					model: options.model,
					permissionMode: options.permissionMode,
					thinkingMode: options.thinkingMode
				},
				imageData.length > 0 ? imageData : undefined
			));

			if (!sent) {
				// Revert on failure so user doesn't lose data
				this.inputText = previousText;
				this.images = previousImages;
				this.saveDraft(chatId);
			}
			return sent;
		} catch (error) {
			console.error('Failed to submit message:', error);
			this.inputText = previousText;
			this.images = previousImages;
			this.saveDraft(chatId);
			return false;
		} finally {
			this.isSubmitting = false;
		}
	}
}

export function createComposerState(): ComposerState {
	return new ComposerState();
}

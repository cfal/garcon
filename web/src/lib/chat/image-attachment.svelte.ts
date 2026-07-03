// Shared attachment state for managing selected files and image object URLs.
// Used by both PromptComposer and NewChatForm.

import { untrack } from 'svelte';

export const CHAT_ATTACHMENT_ACCEPT =
	'image/*,.md,.markdown,.pdf,text/markdown,text/plain,application/pdf';

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set(['md', 'markdown', 'pdf']);
const MIME_BY_EXTENSION: Record<string, string> = {
	markdown: 'text/markdown',
	md: 'text/markdown',
	pdf: 'application/pdf',
};

export function isImageAttachment(file: File): boolean {
	return file.type.startsWith('image/');
}

export function isSupportedChatAttachment(file: File): boolean {
	if (isImageAttachment(file)) return true;
	const mimeType = file.type.toLowerCase();
	if (mimeType === 'application/pdf' || mimeType === 'text/markdown' || mimeType === 'text/plain') {
		return true;
	}
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	return SUPPORTED_ATTACHMENT_EXTENSIONS.has(ext);
}

export function mimeTypeForChatAttachment(file: File): string {
	const explicit = file.type.trim();
	if (explicit) return explicit;
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function imageKey(file: File, idx: number): string {
	return `${file.name}:${file.size}:${file.lastModified}:${idx}`;
}

export class ImageAttachmentState {
	images = $state<File[]>([]);
	urls = $state<Map<string, string>>(new Map());

	/** Adds supported attachment files, deduplicating by name. */
	add(files: File[]): void {
		const existingNames = new Set(this.images.map((f) => f.name));
		const newFiles = files
			.filter(isSupportedChatAttachment)
			.filter((f) => !existingNames.has(f.name));
		if (newFiles.length > 0) {
			this.images = [...this.images, ...newFiles];
		}
	}

	/** Removes the image at the given index. */
	remove(index: number): void {
		this.images = this.images.filter((_, i) => i !== index);
	}

	/** Clears all images and revokes all object URLs. */
	clear(): void {
		this.images = [];
		this.revokeAll();
	}

	/** Returns the object URL for a given image at index. */
	urlFor(file: File, idx: number): string | undefined {
		return this.urls.get(imageKey(file, idx));
	}

	/** Synchronizes object URLs with the current images list.
	 *  Reuses existing URLs for unchanged files and revokes stale ones.
	 *  Call this from an $effect that tracks `this.images`. */
	syncUrls(): void {
		const prev = untrack(() => this.urls);
		const next = new Map<string, string>();
			this.images.forEach((file, idx) => {
				if (!isImageAttachment(file)) return;
				const key = imageKey(file, idx);
				next.set(key, prev.get(key) ?? URL.createObjectURL(file));
			});
		for (const [key, url] of prev) {
			if (!next.has(key)) URL.revokeObjectURL(url);
		}
		this.urls = next;
	}

	/** Revokes all object URLs. Call on cleanup/destroy. */
	revokeAll(): void {
		for (const url of this.urls.values()) URL.revokeObjectURL(url);
		this.urls = new Map();
	}
}

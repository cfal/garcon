// Shared image attachment state for managing file attachments and their
// object URL previews. Used by both PromptComposer and NewChatForm.

import { untrack } from 'svelte';

function imageKey(file: File, idx: number): string {
	return `${file.name}:${file.size}:${file.lastModified}:${idx}`;
}

export class ImageAttachmentState {
	images = $state<File[]>([]);
	urls = $state<Map<string, string>>(new Map());

	/** Adds image files, deduplicating by name. */
	add(files: File[]): void {
		const existingNames = new Set(this.images.map((f) => f.name));
		const newFiles = files
			.filter((f) => f.type.startsWith('image/'))
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

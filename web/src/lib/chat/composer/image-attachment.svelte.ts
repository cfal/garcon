import {
	CHAT_FILE_ATTACHMENT_MIME_TYPES,
	chatAttachmentMimeType,
} from '@garcon/common/attachments';
import { untrack } from 'svelte';

export interface ChatAttachmentSupport {
	allowImages: boolean;
	fileMimeTypes: readonly string[];
}

const DEFAULT_CHAT_ATTACHMENT_SUPPORT: ChatAttachmentSupport = {
	allowImages: true,
	fileMimeTypes: CHAT_FILE_ATTACHMENT_MIME_TYPES,
};

const ACCEPT_TOKENS_BY_MIME: Record<string, readonly string[]> = {
	'application/pdf': ['application/pdf', '.pdf'],
	'text/markdown': ['text/markdown', '.md', '.markdown'],
	'text/plain': ['text/plain', '.txt'],
	'video/mp4': ['video/mp4', '.mp4', '.m4v'],
	'video/quicktime': ['video/quicktime', '.mov'],
	'video/webm': ['video/webm', '.webm'],
	'video/x-matroska': ['video/x-matroska', '.mkv'],
};

export function chatAttachmentAccept(
	support: ChatAttachmentSupport = DEFAULT_CHAT_ATTACHMENT_SUPPORT,
): string {
	const tokens = support.allowImages ? ['image/*', '.svg'] : [];
	for (const mimeType of support.fileMimeTypes) {
		tokens.push(...(ACCEPT_TOKENS_BY_MIME[mimeType] ?? [mimeType]));
	}
	return [...new Set(tokens)].join(',');
}

export const CHAT_ATTACHMENT_ACCEPT = chatAttachmentAccept();

export function mimeTypeForChatAttachment(file: Pick<File, 'name' | 'type'>): string {
	return chatAttachmentMimeType(file);
}

export function isImageAttachment(file: Pick<File, 'name' | 'type'>): boolean {
	return mimeTypeForChatAttachment(file).startsWith('image/');
}

export function isSupportedChatAttachment(
	file: Pick<File, 'name' | 'type'>,
	support: ChatAttachmentSupport = DEFAULT_CHAT_ATTACHMENT_SUPPORT,
): boolean {
	const mimeType = mimeTypeForChatAttachment(file);
	if (mimeType.startsWith('image/')) return support.allowImages;
	return support.fileMimeTypes.includes(mimeType);
}

export function isVideoChatAttachment(file: Pick<File, 'name' | 'type'>): boolean {
	return mimeTypeForChatAttachment(file).startsWith('video/');
}

/** Manages selected attachments and image preview object URLs. */
export class ImageAttachmentState {
	images = $state<File[]>([]);
	#urls = $state<Map<File, string>>(new Map());

	get urls(): ReadonlyMap<File, string> {
		return this.#urls;
	}

	add(files: File[], support: ChatAttachmentSupport = DEFAULT_CHAT_ATTACHMENT_SUPPORT): void {
		const seen = new Set(this.images);
		const newFiles: File[] = [];
		for (const file of files) {
			if (seen.has(file) || !isSupportedChatAttachment(file, support)) continue;
			seen.add(file);
			newFiles.push(file);
		}
		if (newFiles.length > 0) this.images = [...this.images, ...newFiles];
	}

	remove(index: number): void {
		const file = this.images[index];
		if (!file) return;
		const url = this.#urls.get(file);
		if (url) URL.revokeObjectURL(url);
		const next = new Map(this.#urls);
		next.delete(file);
		this.#urls = next;
		this.images = this.images.filter((_, currentIndex) => currentIndex !== index);
	}

	clear(): void {
		this.images = [];
		this.revokeAll();
	}

	urlFor(file: File, _index: number): string | undefined {
		return this.#urls.get(file);
	}

	syncUrls(): void {
		const imageFiles = new Set(this.images.filter(isImageAttachment));
		const next = new Map(untrack(() => this.#urls));
		for (const [file, url] of next) {
			if (!imageFiles.has(file)) {
				URL.revokeObjectURL(url);
				next.delete(file);
			}
		}
		for (const file of imageFiles) {
			if (!next.has(file)) next.set(file, URL.createObjectURL(file));
		}
		this.#urls = next;
	}

	revokeAll(): void {
		for (const url of this.#urls.values()) URL.revokeObjectURL(url);
		this.#urls = new Map();
	}
}

import type { EditorState } from '@codemirror/state';
import type { CanonicalFileIdentity, FileRevision } from '$shared/file-contracts';
import type { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
import { createRandomId } from '$lib/utils/random-id.js';

export type FileContentKind = 'text' | 'markdown' | 'image';
export type FileRendererMode = 'code' | 'markdown' | 'image';

export interface ImageViewState {
	mode: 'fit' | 'manual';
	scale: number;
	focalX: number;
	focalY: number;
	scrollLeft: number;
	scrollTop: number;
}

export function defaultImageViewState(): ImageViewState {
	return {
		mode: 'fit',
		scale: 1,
		focalX: 0.5,
		focalY: 0.5,
		scrollLeft: 0,
		scrollTop: 0,
	};
}

export class FileSession {
	readonly id = createRandomId();
	readonly identityKey: string;
	readonly canonicalFileRootPath: string;
	readonly relativePath: string;

	contentKind = $state<FileContentKind>('text');
	rendererMode = $state<FileRendererMode>('code');
	markdownMode = $state<'rendered' | 'source'>('rendered');
	baseline = $state('');
	content = $state('');
	dirty = $state(false);
	loading = $state(false);
	loadError = $state<string | null>(null);
	saving = $state(false);
	saveError = $state<string | null>(null);
	isExternallyStale = $state(false);
	isCheckingFreshness = $state(false);
	refreshing = $state(false);
	refreshError = $state<string | null>(null);
	freshnessError = $state<string | null>(null);
	requestedLine = $state<number | null>(null);
	requestedColumn = $state<number | null>(null);
	readOnly = $state(false);
	showDiff = $state(false);
	oldContent = $state<string | null>(null);
	image = $state<ImageViewState>(defaultImageViewState());
	imageObjectUrl = $state<string | null>(null);
	pendingMutationCount = $state(0);

	loadedRevision: FileRevision | null = null;
	editorState: EditorState | null = null;
	textScrollTop = 0;
	markdownScrollTop = 0;
	editor: CodeEditorController | null = null;
	loadController: AbortController | null = null;
	freshnessController: AbortController | null = null;
	refreshController: AbortController | null = null;
	freshnessGeneration = 0;
	refreshGeneration = 0;

	constructor(identity: CanonicalFileIdentity, identityKey: string) {
		this.identityKey = identityKey;
		this.canonicalFileRootPath = identity.canonicalFileRootPath;
		this.relativePath = identity.normalizedRelativePath;
	}

	get fileName(): string {
		return this.relativePath.split('/').pop() ?? this.relativePath;
	}

	requestLocation(line?: number, column?: number): void {
		this.requestedLine = line && line > 0 ? line : null;
		this.requestedColumn = column && column > 0 ? column : null;
		this.editor?.applyRequestedLocation();
	}

	dispose(): void {
		this.loadController?.abort();
		this.freshnessGeneration += 1;
		this.freshnessController?.abort();
		this.refreshGeneration += 1;
		this.refreshController?.abort();
		this.editor?.dispose();
		if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
		this.imageObjectUrl = null;
	}
}

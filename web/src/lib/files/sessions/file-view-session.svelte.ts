import type { EditorState, StateEffect } from '@codemirror/state';
import type { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { createRandomId } from '$lib/utils/random-id.js';

export type FileRendererMode = 'code' | 'markdown' | 'image';

export interface ImageViewState {
	mode: 'fit' | 'manual';
	scale: number;
	scrollLeft: number;
	scrollTop: number;
}

export class FileViewSession {
	readonly id: string;
	readonly document: FileDocumentState;
	readonly documentId: string;

	rendererMode = $state<FileRendererMode>('code');
	markdownMode = $state<'rendered' | 'source'>('rendered');
	requestedLine = $state<number | null>(null);
	requestedColumn = $state<number | null>(null);
	image = $state<ImageViewState>({ mode: 'fit', scale: 1, scrollLeft: 0, scrollTop: 0 });
	editor = $state.raw<CodeEditorController | null>(null);
	editorState: EditorState | null = null;
	editorScrollSnapshot: StateEffect<unknown> | null = null;
	textScrollLeft = 0;
	textScrollTop = 0;
	markdownScrollLeft = 0;
	markdownScrollTop = 0;
	lastFocusedAt = $state(Date.now());

	constructor(document: FileDocumentState, id = createRandomId()) {
		this.id = id;
		this.document = document;
		this.documentId = document.id;
		document.attachView(this.id);
	}

	get identityKey(): string {
		return this.document.identityKey;
	}

	get canonicalFileRootPath(): string {
		return this.document.canonicalFileRootPath;
	}

	get relativePath(): string {
		return this.document.relativePath;
	}

	get fileName(): string {
		return this.document.fileName;
	}

	get fullPath(): string {
		return `${this.canonicalFileRootPath.replace(/\/$/, '')}/${this.relativePath}`;
	}

	get contentKind() {
		return this.document.contentKind;
	}

	set contentKind(value) {
		this.document.contentKind = value;
	}

	get baseline(): string {
		return this.document.baseline;
	}

	set baseline(value: string) {
		this.document.baseline = value;
	}

	get content(): string {
		return this.document.content;
	}

	set content(value: string) {
		this.document.content = value;
	}

	get dirty(): boolean {
		return this.document.dirty;
	}

	set dirty(value: boolean) {
		this.document.dirty = value;
	}

	get loading(): boolean {
		return this.document.loading;
	}

	set loading(value: boolean) {
		this.document.loading = value;
	}

	get loadError(): string | null {
		return this.document.loadError;
	}

	set loadError(value: string | null) {
		this.document.loadError = value;
	}

	get loadErrorRequiresPageReload(): boolean {
		return this.document.loadErrorRequiresPageReload;
	}

	set loadErrorRequiresPageReload(value: boolean) {
		this.document.loadErrorRequiresPageReload = value;
	}

	get saving(): boolean {
		return this.document.saving;
	}

	get mutationGuarded(): boolean {
		return this.document.mutationGuarded;
	}

	get saveError(): string | null {
		return this.document.saveError;
	}

	set saveError(value: string | null) {
		this.document.saveError = value;
	}

	get isExternallyStale(): boolean {
		return this.document.isExternallyStale;
	}

	set isExternallyStale(value: boolean) {
		this.document.isExternallyStale = value;
	}

	get isCheckingFreshness(): boolean {
		return this.document.isCheckingFreshness;
	}

	set isCheckingFreshness(value: boolean) {
		this.document.isCheckingFreshness = value;
	}

	get refreshing(): boolean {
		return this.document.refreshing;
	}

	set refreshing(value: boolean) {
		this.document.refreshing = value;
	}

	get refreshError(): string | null {
		return this.document.refreshError;
	}

	set refreshError(value: string | null) {
		this.document.refreshError = value;
	}

	get freshnessError(): string | null {
		return this.document.freshnessError;
	}

	set freshnessError(value: string | null) {
		this.document.freshnessError = value;
	}

	get readOnly(): boolean {
		return this.document.readOnly;
	}

	get imageObjectUrl(): string | null {
		return this.document.imageObjectUrl;
	}

	set imageObjectUrl(value: string | null) {
		this.document.imageObjectUrl = value;
	}

	get loadedRevision() {
		return this.document.loadedRevision;
	}

	set loadedRevision(value) {
		this.document.loadedRevision = value;
	}

	get freshnessController() {
		return this.document.freshnessController;
	}

	set freshnessController(value) {
		this.document.freshnessController = value;
	}

	get refreshController() {
		return this.document.refreshController;
	}

	set refreshController(value) {
		this.document.refreshController = value;
	}

	get freshnessGeneration(): number {
		return this.document.freshnessGeneration;
	}

	set freshnessGeneration(value: number) {
		this.document.freshnessGeneration = value;
	}

	get refreshGeneration(): number {
		return this.document.refreshGeneration;
	}

	set refreshGeneration(value: number) {
		this.document.refreshGeneration = value;
	}

	requestLocation(line?: number, column?: number): void {
		this.requestedLine = line && line > 0 ? line : null;
		this.requestedColumn = column && column > 0 ? column : null;
		this.noteFocused();
		this.editor?.applyRequestedLocation();
	}

	noteFocused(): void {
		this.lastFocusedAt = Date.now();
	}

	dispose(): void {
		this.editor?.dispose();
		this.editor = null;
		this.document.detachView(this.id);
	}
}

// File operations API for reading, writing, browsing, and uploading files.

import { apiGet, apiPut, apiPostForm } from './client.js';

export interface FilePathParams {
	chatId?: string | null;
	projectPath?: string | null;
	filePath: string;
}

export interface DirParams {
	chatId?: string | null;
	projectPath?: string | null;
	dirPath?: string | null;
}

export interface ProjectParams {
	chatId?: string | null;
	projectPath?: string | null;
}

export interface SaveTextParams {
	chatId?: string | null;
	projectPath?: string | null;
	filePath: string;
	content: string;
}

export interface UploadImagesParams {
	chatId?: string | null;
	projectPath?: string | null;
	formData: FormData;
}

export interface FileTreeNode {
	name: string;
	path: string;
	type: 'file' | 'directory';
	children?: FileTreeNode[];
	size?: number;
	modified?: string;
	permissionsRwx?: string;
}

export interface FileEntry {
	name: string;
	path: string;
}

export interface ValidateDirResponse {
	valid: boolean;
	path?: string;
}

export interface BrowseDirResponse {
	entries: Array<{ name: string; type: string }>;
}

export interface ReadTextResponse {
	content?: string;
	[key: string]: unknown;
}

export interface UploadImagesResponse {
	files?: Array<{ name: string; path: string }>;
	[key: string]: unknown;
}

/** Builds query string from chatId/projectPath/filePath. */
function buildFileQuery(params: { chatId?: string | null; projectPath?: string | null; filePath?: string }): string {
	const query = new URLSearchParams();
	if (params.filePath !== undefined) {
		query.append('path', String(params.filePath || ''));
	}
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);
	return query.toString();
}

/** Builds query string from chatId/projectPath/dirPath. */
function buildDirQuery(params: { chatId?: string | null; projectPath?: string | null; dirPath?: string | null }): string {
	const query = new URLSearchParams();
	if (params.dirPath) query.append('path', params.dirPath);
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);
	return query.toString();
}

/** Builds query string from chatId/projectPath only. */
function buildProjectQuery(params: { chatId?: string | null; projectPath?: string | null }): string {
	const query = new URLSearchParams();
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);
	return query.toString();
}

/** Reads file content as text. */
export async function readText(params: FilePathParams, options?: RequestInit): Promise<ReadTextResponse> {
	const qs = buildFileQuery(params);
	return apiGet<ReadTextResponse>(`/api/v1/files/text?${qs}`, options);
}

/** Saves text content to a file. */
export async function saveText(params: SaveTextParams): Promise<{ success: boolean }> {
	const { content, ...rest } = params;
	const qs = buildFileQuery(rest);
	return apiPut<{ success: boolean }>(`/api/v1/files/text?${qs}`, { content });
}

/** Fetches the file tree for a project directory. */
export async function getTree(params: DirParams = {}, options?: RequestInit): Promise<FileTreeNode[]> {
	const qs = buildDirQuery(params);
	const url = `/api/v1/files/tree${qs ? `?${qs}` : ''}`;
	return apiGet<FileTreeNode[]>(url, options);
}

/** Fetches a flat file list for a project. */
export async function getFileList(params: ProjectParams = {}, options?: RequestInit): Promise<FileEntry[]> {
	const qs = buildProjectQuery(params);
	const url = `/api/v1/files/list${qs ? `?${qs}` : ''}`;
	return apiGet<FileEntry[]>(url, options);
}

/** Returns the URL for fetching raw file content (no fetch performed). */
export function getContentUrl(params: FilePathParams): string {
	const qs = buildFileQuery(params);
	return `/api/v1/files/content?${qs}`;
}

/** Uploads images via FormData. */
export async function uploadImages(params: UploadImagesParams): Promise<UploadImagesResponse> {
	const qs = buildProjectQuery(params);
	const url = `/api/v1/files/upload-images${qs ? `?${qs}` : ''}`;
	return apiPostForm<UploadImagesResponse>(url, params.formData);
}

/** Validates that a directory path exists and is accessible. */
export async function validateDir(dirPath: string): Promise<ValidateDirResponse> {
	return apiGet<ValidateDirResponse>(`/api/v1/files/validate-dir?path=${encodeURIComponent(dirPath)}`);
}

/** Browses directory contents for the file picker. */
export async function browseDir(dirPath: string): Promise<BrowseDirResponse> {
	return apiGet<BrowseDirResponse>(`/api/v1/files/browse?path=${encodeURIComponent(dirPath)}`);
}

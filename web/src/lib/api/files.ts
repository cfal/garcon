// File operations API for reading, writing, browsing, and uploading files.

import { apiFetch, apiGet, apiPut, apiPostForm } from './client.js';
import {
	parseFileIdentityResponse,
	parseFileTreeResponse,
	type FileIdentityResponse,
	type FileTreeResponse,
} from '$shared/file-contracts';

export interface FilePathParams {
	chatId?: string | null;
	projectPath?: string | null;
	filePath: string;
}

export interface FileIdentityParams {
	chatId?: string | null;
	projectPath?: string | null;
	relativePath: string;
}

export interface FileTreeParams {
	directoryPath?: string | null;
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

export interface FileEntry {
	name: string;
	path: string;
	relativePath?: string;
	type?: 'file' | 'directory';
}

export interface ReadTextResponse {
	content?: string;
	[key: string]: unknown;
}

export interface UploadImagesResponse {
	attachments?: Array<{ name: string; data: string; size: number; mimeType: string }>;
	files?: Array<{ name: string; path: string }>;
	images?: Array<{ name: string; data: string; size: number; mimeType: string }>;
	[key: string]: unknown;
}

/** Builds query string from chatId/projectPath/filePath. */
function buildFileQuery(params: {
	chatId?: string | null;
	projectPath?: string | null;
	filePath?: string;
}): string {
	const query = new URLSearchParams();
	if (params.filePath !== undefined) {
		query.append('path', String(params.filePath || ''));
	}
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);
	return query.toString();
}

/** Builds query string from chatId/projectPath only. */
function buildProjectQuery(params: {
	chatId?: string | null;
	projectPath?: string | null;
}): string {
	const query = new URLSearchParams();
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);
	return query.toString();
}

/** Reads file content as text. */
export async function readText(
	params: FilePathParams,
	options?: RequestInit,
): Promise<ReadTextResponse> {
	const qs = buildFileQuery(params);
	return apiGet<ReadTextResponse>(`/api/v1/files/text?${qs}`, options);
}

export async function resolveFileIdentity(
	params: FileIdentityParams,
	options?: RequestInit,
): Promise<FileIdentityResponse> {
	const query = buildFileQuery({
		chatId: params.chatId,
		projectPath: params.projectPath,
		filePath: params.relativePath,
	});
	const payload = await apiGet<unknown>(`/api/v1/files/identity?${query}`, options);
	const parsed = parseFileIdentityResponse(payload);
	if (!parsed) throw new Error('Invalid file identity response');
	return parsed;
}

/** Saves text content to a file. */
export async function saveText(params: SaveTextParams): Promise<{ success: boolean }> {
	const { content, ...rest } = params;
	const qs = buildFileQuery(rest);
	return apiPut<{ success: boolean }>(`/api/v1/files/text?${qs}`, { content });
}

/** Fetches and validates one directory under the configured project base. */
export async function getTree(
	params: FileTreeParams = {},
	options?: RequestInit,
): Promise<FileTreeResponse> {
	const query = new URLSearchParams();
	if (params.directoryPath) query.set('path', params.directoryPath);
	const qs = query.toString();
	const url = `/api/v1/files/tree${qs ? `?${qs}` : ''}`;
	const payload = await apiGet<unknown>(url, options);
	const response = parseFileTreeResponse(payload);
	if (!response) throw new Error('Invalid file tree response');
	return response;
}

/** Fetches a flat file list for a project. */
export async function getFileList(
	params: ProjectParams = {},
	options?: RequestInit,
): Promise<FileEntry[]> {
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

/** Uploads chat attachments via FormData. */
export async function uploadAttachments(params: UploadImagesParams): Promise<UploadImagesResponse> {
	const qs = buildProjectQuery(params);
	const url = `/api/v1/files/upload-attachments${qs ? `?${qs}` : ''}`;
	return apiPostForm<UploadImagesResponse>(url, params.formData);
}

export interface DirectoryEntry {
	name: string;
	path: string;
	type: string;
}

/** Fetches directory entries for the directory browser. Returns the raw
 *  array the server sends, validated to be an Array. */
export async function browseDirectory(
	path: string,
	signal?: AbortSignal,
): Promise<DirectoryEntry[]> {
	const response = await apiFetch(`/api/v1/files/browse?path=${encodeURIComponent(path)}`, {
		signal,
	});
	const payload = await response.json();
	if (!Array.isArray(payload)) {
		throw new Error('Invalid directory browse payload');
	}
	return payload;
}

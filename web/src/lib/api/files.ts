// File operations API for reading, writing, browsing, and uploading files.

import {
	ApiError,
	ApiMutationOutcomeUnknownError,
	apiFetch,
	apiGet,
	apiPost,
	apiPut,
	isIntermediaryResponse,
	parseApiResponse,
	type ApiFetchOptions,
} from './client.js';
import {
	FILE_REVISION_HEADER,
	isFileRevision,
	parseDirectoryEntry,
	parseFileIdentityResponse,
	parseFileRevisionResponse,
	parseFileTreeResponse,
	parseReadTextResponse,
	parseSaveTextResponse,
	type DirectoryEntry,
	type FileRevision,
	type FileRevisionResponse,
	type FileSaveConflictResolution,
	type FileIdentityResponse,
	type FileTreeResponse,
	type ReadTextResponse,
	type SaveTextResponse,
} from '$shared/file-contracts';

export interface FilePathParams {
	executorId?: string | null;
	chatId?: string | null;
	projectPath?: string | null;
	filePath: string;
}

export interface FileIdentityParams {
	executorId?: string | null;
	chatId?: string | null;
	projectPath?: string | null;
	relativePath: string;
}

export interface FileTreeParams {
	executorId?: string | null;
	directoryPath?: string | null;
}

export interface ProjectParams {
	executorId?: string | null;
	chatId?: string | null;
	projectPath?: string | null;
}

export interface SaveTextParams {
	executorId?: string | null;
	chatId?: string | null;
	projectPath?: string | null;
	filePath: string;
	content: string;
	expectedRevision: FileRevision;
	conflictResolution: FileSaveConflictResolution;
}

export interface CreateDirectoryParams {
	executorId?: string | null;
	parentPath: string;
	name: string;
}

export interface FileEntry {
	name: string;
	path: string;
	relativePath?: string;
	type?: 'file' | 'directory';
}

/** Builds query string from chatId/projectPath/filePath. */
function buildFileQuery(params: {
	executorId?: string | null;
	chatId?: string | null;
	projectPath?: string | null;
	filePath?: string;
}): string {
	const query = new URLSearchParams();
	if (params.executorId) query.set('executorId', params.executorId);
	if (params.filePath !== undefined) {
		query.append('path', String(params.filePath || ''));
	}
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);
	return query.toString();
}

/** Builds query string from chatId/projectPath only. */
function buildProjectQuery(params: {
	executorId?: string | null;
	chatId?: string | null;
	projectPath?: string | null;
}): string {
	const query = new URLSearchParams();
	if (params.executorId) query.set('executorId', params.executorId);
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
	const payload = await apiGet<unknown>(`/api/v1/files/text?${qs}`, options);
	const parsed = parseReadTextResponse(payload);
	if (!parsed) throw new Error('Invalid file text response');
	return parsed;
}

export async function getFileRevision(
	params: FilePathParams,
	options?: RequestInit,
): Promise<FileRevisionResponse> {
	const qs = buildFileQuery(params);
	const payload = await apiGet<unknown>(`/api/v1/files/revision?${qs}`, options);
	const parsed = parseFileRevisionResponse(payload);
	if (!parsed) throw new Error('Invalid file revision response');
	return parsed;
}

export async function resolveFileIdentity(
	params: FileIdentityParams,
	options?: RequestInit,
): Promise<FileIdentityResponse> {
	const query = buildFileQuery({
		executorId: params.executorId,
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
export async function saveText(
	params: SaveTextParams,
	options?: ApiFetchOptions,
): Promise<SaveTextResponse> {
	const { content, expectedRevision, conflictResolution, ...rest } = params;
	const qs = buildFileQuery(rest);
	const payload = await apiPut<unknown>(
		`/api/v1/files/text?${qs}`,
		{
			content,
			expectedRevision,
			conflictResolution,
		},
		options,
	);
	const parsed = parseSaveTextResponse(payload);
	if (!parsed) throw new Error('Invalid file save response');
	return parsed;
}

/** Fetches and validates one directory under the configured project base. */
export async function getTree(
	params: FileTreeParams = {},
	options?: RequestInit,
): Promise<FileTreeResponse> {
	const query = new URLSearchParams();
	if (params.executorId) query.set('executorId', params.executorId);
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

export async function readContent(
	params: FilePathParams,
	options?: RequestInit,
): Promise<{ blob: Blob; revision: FileRevision }> {
	const response = await apiFetch(getContentUrl(params), options);
	if (!response.ok) await parseApiResponse<never>(response);
	const revision = response.headers.get(FILE_REVISION_HEADER);
	if (!isFileRevision(revision)) throw new Error('Invalid file content revision');
	return { blob: await response.blob(), revision };
}

/** Fetches the directories inside one directory for the directory browser. */
export async function browseDirectory(
	path: string,
	signal?: AbortSignal,
	executorId?: string | null,
): Promise<DirectoryEntry[]> {
	const query = new URLSearchParams({ path });
	if (executorId) query.set('executorId', executorId);
	const response = await apiFetch(`/api/v1/files/browse?${query}`, {
		signal,
	});
	if (!response.ok) await parseApiResponse<never>(response);
	const payload = await response.json();
	const entries = Array.isArray(payload) ? payload.map(parseDirectoryEntry) : null;
	if (!entries || entries.some((entry) => entry === null)) {
		throw new Error('Invalid directory browse payload');
	}
	return entries as DirectoryEntry[];
}

/** Creates one directory inside an existing parent on the selected executor.
 *  Rejects with ApiMutationOutcomeUnknownError when the directory may exist. */
export async function createDirectory(params: CreateDirectoryParams): Promise<DirectoryEntry> {
	const query = new URLSearchParams({ path: params.parentPath });
	if (params.executorId) query.set('executorId', params.executorId);
	try {
		const payload = await apiPost<unknown>(`/api/v1/files/directories?${query}`, {
			name: params.name,
		});
		const created = parseDirectoryEntry(payload);
		if (!created) throw new ApiMutationOutcomeUnknownError('Invalid directory creation response');
		return created;
	} catch (error) {
		if (error instanceof ApiMutationOutcomeUnknownError) throw error;
		if (
			error instanceof ApiError &&
			!isIntermediaryResponse(error) &&
			error.errorCode !== 'FILE_CREATE_OUTCOME_UNKNOWN'
		) {
			throw error;
		}
		throw new ApiMutationOutcomeUnknownError(
			'The directory creation outcome could not be confirmed.',
			{ cause: error },
		);
	}
}

import { ApiError } from '$lib/api/client.js';
import type { FileIdentityResponse } from '$shared/file-contracts';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import type { SpaFileViewV1 } from '$lib/files/persistence/file-draft-repository.js';
import type { FileOpenRequest } from '$lib/files/sessions/file-session-registry.svelte.js';
import { fileContentKind } from '$lib/files/sessions/file-open-mode.js';
import type { DesktopPlacement, PresentationHostId } from '$lib/workspace/surface-types.js';

export interface RestoredViewPreparation {
	identity: FileIdentityResponse['identity'];
	document: FileDocumentState | null;
	request: FileOpenRequest;
}

export async function prepareRestoredView(
	record: SpaFileViewV1,
	recovered: FileDocumentState | null,
	resolveIdentity: (input: {
		projectPath: string;
		relativePath: string;
	}) => Promise<FileIdentityResponse>,
	identityKey: (root: string, relativePath: string) => string,
	target?: DesktopPlacement,
): Promise<RestoredViewPreparation> {
	const request: FileOpenRequest = {
		fileRootPath: record.canonicalFileRootPath,
		relativePath: record.normalizedRelativePath,
		mode: record.rendererMode,
		origin: record.placement,
		target: target ?? placementFor(record.placement),
		reason: 'restored-view',
		openToSide: true,
		line: record.line,
		col: record.column,
	};
	if (recovered) {
		await probeRecovered(recovered, resolveIdentity);
		return {
			identity: {
				canonicalFileRootPath: recovered.canonicalFileRootPath,
				normalizedRelativePath: recovered.relativePath,
			},
			document: recovered,
			request,
		};
	}
	try {
		const response = await resolveIdentity({
			projectPath: record.canonicalFileRootPath,
			relativePath: record.normalizedRelativePath,
		});
		return { identity: response.identity, document: null, request };
	} catch (error) {
		const identity = {
			canonicalFileRootPath: record.canonicalFileRootPath,
			normalizedRelativePath: record.normalizedRelativePath,
		};
		const document = new FileDocumentState(
			identity,
			identityKey(identity.canonicalFileRootPath, identity.normalizedRelativePath),
			record.documentId,
		);
		document.contentKind = fileContentKind(record.normalizedRelativePath, record.rendererMode);
		document.missing = error instanceof ApiError && error.status === 404;
		document.loadError = error instanceof Error ? error.message : String(error);
		document.loading = false;
		return { identity, document, request };
	}
}

async function probeRecovered(
	document: FileDocumentState,
	resolveIdentity: (input: {
		projectPath: string;
		relativePath: string;
	}) => Promise<FileIdentityResponse>,
): Promise<void> {
	try {
		await resolveIdentity({
			projectPath: document.canonicalFileRootPath,
			relativePath: document.relativePath,
		});
	} catch (error) {
		document.missing = error instanceof ApiError && error.status === 404;
		document.loadError = error instanceof Error ? error.message : String(error);
	}
}

function placementFor(host: PresentationHostId): DesktopPlacement | undefined {
	if (host === 'dialog') return { type: 'dialog' };
	if (host === 'mobile') return undefined;
	return { type: 'window', windowId: host };
}

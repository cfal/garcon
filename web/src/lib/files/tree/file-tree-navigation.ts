import { ApiError } from '$lib/api/client.js';
import type { FileTreeBreadcrumb, FileTreeResponse } from '$shared/file-contracts';

export interface FileTreeNavigationError {
	message: string;
	status?: number;
	errorCode?: string;
	retryable: boolean;
}

export type FileTreeDirectoryTargetReason =
	| 'initial'
	| 'executor-switch'
	| 'directory-row'
	| 'parent-row'
	| 'breadcrumb'
	| 'home'
	| 'chat-project'
	| 'reveal-file';

export interface FileTreeDirectoryTarget {
	path: string;
	label: string;
	breadcrumbs: FileTreeBreadcrumb[];
	reason: FileTreeDirectoryTargetReason;
	focusPathOnSuccess?: string;
	captureAsChatProject?: boolean;
}

export type FileTreeNavigationState =
	| { kind: 'idle' }
	| {
			kind: 'loading';
			target: FileTreeDirectoryTarget;
			previous: FileTreeResponse | null;
	  }
	| { kind: 'ready'; response: FileTreeResponse }
	| {
			kind: 'error';
			target: FileTreeDirectoryTarget;
			previous: FileTreeResponse | null;
			error: FileTreeNavigationError;
	  };

export function fileTreeNavigationError(error: unknown): FileTreeNavigationError {
	if (error instanceof ApiError) {
		return {
			message: error.message,
			status: error.status,
			errorCode: error.errorCode,
			retryable: error.retryable || error.status >= 500,
		};
	}
	return {
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
	};
}

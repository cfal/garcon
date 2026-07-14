import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';

export interface WorkspacePublication {
	publish(): void;
	rollback(): void;
}

export interface WorkspaceCommitOptions {
	publication?: WorkspacePublication;
	presentationMode?: 'desktop' | 'mobile';
	requiredPublication?: boolean;
}

export type WorkspaceCommit = (
	mutations: WorkspaceMutationPlan,
	options?: WorkspaceCommitOptions,
) => Promise<boolean>;

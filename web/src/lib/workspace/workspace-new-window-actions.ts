import type { PortableSingletonKind } from './surface-types.js';

export interface WorkspaceNewWindowActions {
	readonly windowLimitReached: boolean;
	readonly terminalLimitReached: boolean;
	readonly singletonKinds: readonly PortableSingletonKind[];
	createTerminal(): void;
	openSingleton(kind: PortableSingletonKind): void;
}

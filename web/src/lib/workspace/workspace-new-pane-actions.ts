import type { PortableSingletonKind } from './surface-types.js';

export interface WorkspaceNewPaneActions {
	readonly terminalLimitReached: boolean;
	readonly singletonKinds: readonly PortableSingletonKind[];
	createTerminal(): void;
	openSingleton(kind: PortableSingletonKind): void;
}

import type { CanvasRecoveryPort } from './canvas-recovery.js';

const owners = new WeakMap<CanvasRecoveryPort, Map<string, symbol>>();

// Reopening a board supersedes every pending operation from its previous session.
export function claimCanvasRecovery(recovery: CanvasRecoveryPort, id: string) {
	let boardOwners = owners.get(recovery);
	if (!boardOwners) {
		boardOwners = new Map();
		owners.set(recovery, boardOwners);
	}
	const token = Symbol(id);
	boardOwners.set(id, token);
	return {
		isCurrent: () => boardOwners.get(id) === token,
		release() {
			if (boardOwners.get(id) === token) boardOwners.delete(id);
		},
	};
}

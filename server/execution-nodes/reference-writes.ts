import { effectiveNodeId, LOCAL_EXECUTION_NODE_ID } from '../../common/execution-nodes.js';
import { DomainError } from '../lib/domain-error.js';

type NodeIds = readonly (string | null | undefined)[];
export type RetainNodeReferences = (next: NodeIds, current?: NodeIds) => () => void;

export class ExecutionNodeReferenceWrites {
  readonly #writers = new Map<string, number>();

  constructor(private readonly assertWritable: (nodeId: string) => void) {}

  retain: RetainNodeReferences = (next, current = []) => {
    const previous = remoteIds(current);
    const nodes = remoteIds(next);
    for (const id of nodes) if (!previous.has(id)) this.assertWritable(id);
    for (const id of previous) nodes.add(id);
    for (const id of nodes) this.#writers.set(id, (this.#writers.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of nodes) {
        const remaining = this.#writers.get(id)! - 1;
        if (remaining === 0) this.#writers.delete(id);
        else this.#writers.set(id, remaining);
      }
    };
  };

  assertNoWrites(nodeId: string): void {
    if (this.#writers.has(nodeId)) {
      throw new DomainError('EXECUTION_NODE_IN_USE', 'A reference to this node is being saved. Try deleting it after the save finishes.', 409, true);
    }
  }
}

function remoteIds(values: NodeIds): Set<string> {
  return new Set(values.map(effectiveNodeId).filter((id) => id !== LOCAL_EXECUTION_NODE_ID));
}

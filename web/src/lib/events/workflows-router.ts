import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { parseServerWsMessage, WorkflowInvalidatedMessage } from '$shared/ws-events';

export class WorkflowsRouter {
  #handle: DrainHandle | null = null;
  constructor(private readonly ws: WsMessageLog, private readonly invalidate: (workflowId: string) => void) {}
  start(): void { this.#handle ??= createDrainCursor(this.ws); }
  tick(): void {
    for (const message of this.#handle?.drain() ?? []) {
      if (message.data.type !== 'workflow-invalidated') continue;
      const parsed = parseServerWsMessage(message.data);
      if (parsed instanceof WorkflowInvalidatedMessage) this.invalidate(parsed.workflowId);
    }
  }
  destroy(): void { this.#handle?.cleanup(); this.#handle = null; }
}

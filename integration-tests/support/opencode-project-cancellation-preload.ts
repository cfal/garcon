import { writeFileSync } from 'node:fs';
import OpenCodeIntegration from '../../server-agents/opencode/src/index.js';
import { OpenCodeRuntime } from '../../server-agents/opencode/src/agents/opencode/opencode.js';
import type { AgentHost } from '../../server-agents/interface/src/index.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';

const diagnosticsPath = process.env.GARCON_TEST_PROJECT_CANCELLATION_DIAGNOSTICS ?? '';
if (!diagnosticsPath) throw new Error('Project cancellation fixture requires a diagnostics path');
const cancellations = new WeakMap<AbortSignal, AbortController>();
const diagnostics = {
  preparations: 0, returnedPreparation: false, rollbacks: 0,
  moves: [] as { sessionId: string; directory: string; aborted: boolean }[],
};

const moveSession = OpenCodeRuntime.prototype.moveSession;
OpenCodeRuntime.prototype.moveSession = async function (sessionId, directory, signal) {
  await moveSession.call(this, sessionId, directory, signal);
  diagnostics.moves.push({ sessionId, directory, aborted: signal.aborted });
  cancellations.get(signal)?.abort(new Error('Synthetic cancellation after confirmed native move'));
};

class CancelledProjectPathIntegration extends OpenCodeIntegration {
  constructor(host: AgentHost) {
    super(host);
    const prepare = this.projectPathUpdates.prepare.bind(this.projectPathUpdates);
    this.projectPathUpdates.prepare = async (request) => {
      diagnostics.preparations += 1;
      const controller = diagnostics.preparations === 1 ? new AbortController() : null;
      if (controller) cancellations.set(controller.signal, controller);
      try {
        const preparation = await prepare({ ...request, signal: controller?.signal ?? request.signal });
        if (controller?.signal.aborted) {
          diagnostics.returnedPreparation = Boolean(preparation);
          if (!preparation) throw new Error('Cancelled native move lost its rollback handle');
          await preparation.rollback();
          diagnostics.rollbacks += 1;
          controller.signal.throwIfAborted();
        }
        return preparation;
      } finally {
        if (controller) cancellations.delete(controller.signal);
        writeFileSync(diagnosticsPath, JSON.stringify(diagnostics));
      }
    };
  }
}

const index = defaultAgentIntegrations.indexOf(OpenCodeIntegration);
if (index < 0) throw new Error('Missing OpenCode integration in project cancellation fixture');
defaultAgentIntegrations[index] = CancelledProjectPathIntegration;

import DirectOpenAiCompatibleIntegration from '../../server-agents/direct-openai-compatible/src/index.js';
import type { AgentHost } from '../../server-agents/interface/src/index.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';
import { AgentRuntimeRouter } from '../../server/agents/runtime-router.js';
import { LocalProviderConfigurationService } from '../../server/execution-node/local-provider-configuration.js';

const mode = process.env.GARCON_TEST_SINGLE_QUERY_CANCEL;
if (mode !== 'validation' && mode !== 'result') throw new Error('One-shot fixture requires an explicit cancellation phase');

const controllers = new WeakMap<AbortSignal, AbortController>();
let cancelNext = true;
function cancelOnce(signal: AbortSignal): void {
  const controller = controllers.get(signal);
  if (!controller || !cancelNext) return;
  cancelNext = false;
  controller.abort(new Error('Synthetic one-shot cancellation'));
}

const runSingleQuery = AgentRuntimeRouter.prototype.runSingleQuery;
AgentRuntimeRouter.prototype.runSingleQuery = async function (prompt, options) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  controllers.set(signal, controller);
  try { return await runSingleQuery.call(this, prompt, { ...options, signal }); }
  finally { controllers.delete(signal); }
};

const resolve = LocalProviderConfigurationService.prototype.resolve;
LocalProviderConfigurationService.prototype.resolve = async function (request, signal) {
  const result = await resolve.call(this, request, signal);
  if (mode === 'validation') cancelOnce(signal);
  return result;
};

class CancelledSingleQueryIntegration extends DirectOpenAiCompatibleIntegration {
  constructor(host: AgentHost) {
    super(host);
    const run = this.singleQuery.run.bind(this.singleQuery);
    this.singleQuery.run = async (request) => {
      const result = await run(request);
      if (mode === 'result') cancelOnce(request.signal);
      return result;
    };
  }
}

const index = defaultAgentIntegrations.indexOf(DirectOpenAiCompatibleIntegration);
if (index < 0) throw new Error('Missing Direct integration in one-shot fixture');
defaultAgentIntegrations[index] = CancelledSingleQueryIntegration;

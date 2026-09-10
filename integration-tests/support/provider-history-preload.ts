import DirectOpenAiCompatibleIntegration from '../../server-agents/direct-openai-compatible/src/index.js';
import type { AgentHost } from '../../server-agents/interface/src/index.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';
import { TranscriptReloadService } from '../../server/ledger/reload.js';

const mode = process.env.GARCON_TEST_HISTORY_IMPORT;
if (mode !== 'mutate' && mode !== 'cancel-empty' && mode !== 'cancel-rows' && mode !== 'fail-cleanup') {
  throw new Error('History import fixture requires an explicit fault mode');
}

const controllers = new WeakMap<AbortSignal, AbortController>();
const reload = TranscriptReloadService.prototype.reload;
TranscriptReloadService.prototype.reload = async function (chatId, signal) {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  controllers.set(requestSignal, controller);
  try { return await reload.call(this, chatId, requestSignal); }
  finally { controllers.delete(requestSignal); }
};

class FaultedHistoryIntegration extends DirectOpenAiCompatibleIntegration {
  constructor(host: AgentHost) {
    super(host);
    const load = this.nativeHistoryImport.load.bind(this.nativeHistoryImport);
    if (mode === 'fail-cleanup') {
      let failNextImport = true;
      this.nativeHistoryImport.load = (request) => {
        if (!failNextImport) return load(request);
        failNextImport = false;
        return { [Symbol.asyncIterator]: () => ({
          next: async () => { throw new Error('Synthetic original import failure'); },
          return: async () => { throw new Error('Synthetic cleanup failure'); },
        }) };
      };
      return;
    }
    let cancelNextImport = mode !== 'mutate';
    this.nativeHistoryImport.load = async function* (request) {
      const cancel = cancelNextImport;
      cancelNextImport = false;
      for await (const batch of load(request)) {
        if (!(cancel && mode === 'cancel-empty')) yield batch;
        if (mode === 'mutate') {
          for (const { message } of batch) {
            if ('content' in message && typeof message.content === 'string') {
              message.content = 'Synthetic provider mutation after yield';
            }
          }
        }
      }
      if (cancel) {
        const controller = controllers.get(request.signal);
        if (!controller) throw new Error('Missing fixture reload controller');
        controller.abort(new Error('Synthetic native import cancellation at EOF'));
      }
    };
  }
}

const index = defaultAgentIntegrations.indexOf(DirectOpenAiCompatibleIntegration);
if (index < 0) throw new Error('Missing Direct integration in history fixture');
defaultAgentIntegrations[index] = FaultedHistoryIntegration;

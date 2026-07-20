import type {
  AgentTranscriptIndexSourceRef,
  AgentTranscriptIndexerModule,
} from '@garcon/server-agent-interface';
import {
  sourceFailure,
  yieldBoundedMessageBatches,
} from '@garcon/server-agent-common/search/index-source-helpers';
import { AmpCliRuntime } from './agents/amp/amp-cli.js';
import { loadAmpChatMessages } from './agents/amp/history-loader.js';

function parseSource(source: AgentTranscriptIndexSourceRef) {
  const threadId = source.value.threadId;
  const projectPath = source.value.projectPath;
  const binary = source.value.binary;
  if (source.ownerId !== 'amp'
      || source.schemaVersion !== 1
      || typeof threadId !== 'string'
      || typeof projectPath !== 'string'
      || typeof binary !== 'string') {
    throw sourceFailure('SOURCE_DESCRIPTOR_INVALID', false);
  }
  return { threadId, projectPath, binary };
}

const moduleDefinition: AgentTranscriptIndexerModule = {
  integrationId: 'amp',
  apiVersion: 1,
  create(host) {
    const runtimes = new Map<string, AmpCliRuntime>();
    const runtimeFor = (binary: string) => {
      let runtime = runtimes.get(binary);
      if (!runtime) {
        runtime = new AmpCliRuntime({ config: { binary: () => binary }, logger: host.logger });
        runtimes.set(binary, runtime);
      }
      return runtime;
    };
    return {
      async probe(source, signal) {
        signal.throwIfAborted();
        parseSource(source);
        return { revision: null };
      },
      async *load(request) {
        request.signal.throwIfAborted();
        const source = parseSource(request.source);
        let exported: Awaited<ReturnType<AmpCliRuntime['exportThread']>>;
        try {
          exported = await runtimeFor(source.binary).exportThread(
            source.threadId,
            {
              cwd: source.projectPath,
              signal: request.signal,
              tempDirectory: request.scratchDirectory,
            },
          );
          request.signal.throwIfAborted();
        } catch (error) {
          request.signal.throwIfAborted();
          if (error instanceof Error && error.name === 'AgentTranscriptIndexError') throw error;
          throw sourceFailure('SOURCE_EXPORT_FAILED', true, true);
        }
        let messages: Awaited<ReturnType<typeof loadAmpChatMessages>>;
        try {
          messages = await loadAmpChatMessages(exported);
        } catch {
          throw sourceFailure('SOURCE_RECORD_INVALID', false);
        }
        yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
      },
      async close() {
        for (const runtime of runtimes.values()) runtime.shutdown();
        runtimes.clear();
      },
    };
  },
};

export default moduleDefinition;

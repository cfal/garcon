import { AgentIntegrationError, type AgentSingleQueryLifetime } from '@garcon/server-agent-interface';
import { NativeQueryLifetime } from '@garcon/server-agent-common/execution/native-query-lifetime';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import type { ClaudeConfig } from '../../config.js';
import { buildClaudeEndpointRuntime, buildClaudeHostEnvironment } from './endpoint-runtime.js';
import { classifyClaudeError } from './errors.js';
import { buildClaudeCLIArgs, type ClaudeCliDependencies } from './cli-invocation.js';
import { runClaudeSingleQueryProcess } from './single-query-process.js';

export function createClaudeSingleQueryLifetime(config: ClaudeConfig, dependencies: ClaudeCliDependencies): AgentSingleQueryLifetime {
  return {
    begin(input) {
      const { signal, ...values } = input;
      const request = structuredClone(values);
      const binary = dependencies.binary();
      const environment = buildClaudeHostEnvironment(config);
      const native = new NativeQueryLifetime(signal, request.timeoutMs, 'Claude query cancelled');
      return native.begin(async (querySignal) => {
        const endpoint = request.endpoint ? buildClaudeEndpointRuntime(request.endpoint) : null;
        if (request.endpoint && !endpoint) {
          throw new AgentIntegrationError('INVALID_ENDPOINT', 'Claude requires an Anthropic Messages endpoint', false);
        }
        const args = buildClaudeCLIArgs({
          prompt: request.prompt, model: request.model,
          ...singleQueryRuntimeOptions({ ...request, signal: querySignal }),
        });
        try {
          native.enter();
          const version = dependencies.versionProbe.check(binary);
          native.track(version.drained);
          await version.result;
          querySignal.throwIfAborted();
          return await runClaudeSingleQueryProcess({
            binary, args, cwd: request.projectPath, signal: querySignal, logger: dependencies.logger,
            envOverrides: { ...environment, ...endpoint?.envOverrides }, nativeLifetime: native,
          });
        } catch (error) {
          querySignal.throwIfAborted();
          throw classifyClaudeError(error);
        }
      });
    },
  };
}

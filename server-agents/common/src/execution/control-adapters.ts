import {
  AgentCallError,
  type AgentGoalControlPreparation,
  type AgentGoals,
  type AgentSteering,
  type AgentSteerResult,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from './resource-table.js';
import type { AgentProducerAdapter } from './producer-adapter.js';
import type { AgentRuntimePublisher, RuntimeGoalControlRequest, RuntimeSteerRequest, RuntimeSteerTarget } from './runtime-events.js';

const PREPARATION_TIMEOUT_MS = 30_000;

export function createAgentSteering(
  producer: AgentProducerAdapter,
  runtime: {
    captureTarget(agentSessionId: string): RuntimeSteerTarget | null;
    steer(request: RuntimeSteerRequest): Promise<AgentSteerResult>;
  },
): AgentSteering {
  const targets = new AgentResourceTable<'steer-target', {
    readonly operation: NonNullable<ReturnType<AgentProducerAdapter['expectedOperation']>>;
    readonly target: RuntimeSteerTarget;
    timer: ReturnType<typeof setTimeout> | null;
  }>(producer.producers.scope, 'steer-target', 256);
  return {
    async captureTarget(request, options) {
      options?.signal?.throwIfAborted();
      const operation = producer.expectedOperation(request);
      if (!operation) return null;
      const target = runtime.captureTarget(request.agentSessionId);
      if (!target) return null;
      const captured = { operation, target, timer: null as ReturnType<typeof setTimeout> | null };
      const ref = targets.add(captured);
      captured.timer = setTimeout(() => targets.delete(ref), PREPARATION_TIMEOUT_MS);
      captured.timer.unref();
      return ref;
    },
    async steer(request, options) {
      options?.signal?.throwIfAborted();
      if (!request.target) return { kind: 'rejected', reason: 'no-active-turn', message: 'No active turn' };
      const captured = targets.take(request.target);
      if (captured.timer) clearTimeout(captured.timer);
      if (captured.operation.binding.chatId !== request.chatId
        || captured.operation.agentSessionId !== request.agentSessionId) {
        throw new AgentCallError('rejected', 'Steering resource mismatch', 'STALE_RESOURCE');
      }
      producer.assertCurrent(captured.operation);
      return runtime.steer({
        ...request,
        target: captured.target,
        prepareDelivery: async () => {
          options?.signal?.throwIfAborted();
          producer.assertCurrent(captured.operation);
        },
      });
    },
  };
}

export function createAgentGoals(
  producer: AgentProducerAdapter,
  submit: (request: RuntimeGoalControlRequest, publish: AgentRuntimePublisher) => Promise<boolean>,
): AgentGoals {
  const preparations = new AgentResourceTable<'goal-preparation', {
    deliver(): Promise<void>;
    cancel(): void;
    timer: ReturnType<typeof setTimeout> | null;
  }>(producer.producers.scope, 'goal-preparation', 64);
  return {
    async prepareControl(request, options) {
      options?.signal?.throwIfAborted();
      const predecessor = producer.expectedOperation(request);
      if (!predecessor) return null;
      const successor = producer.prepareSuccessor(predecessor, request, options);
      const prepared = Promise.withResolvers<AgentGoalControlPreparation | null>();
      let reserved = false;
      const completion = submit({
        ...successor.runtimeRequest,
        beforeDelivery: async (handoff) => {
          producer.assertCurrent(predecessor);
          handoff.validate();
          const delivery = Promise.withResolvers<void>();
          void delivery.promise.catch(() => undefined);
          let pending = true;
          const preparation = {
            timer: null as ReturnType<typeof setTimeout> | null,
            cancel() {
              pending = false;
              successor.abandon();
              delivery.reject(new AgentCallError('rejected', 'Goal preparation cancelled'));
            },
            async deliver() {
              try {
                if (!pending) throw new AgentCallError('rejected', 'Goal preparation retired', 'STALE_RESOURCE');
                pending = false;
                producer.assertCurrent(predecessor);
                handoff.validate();
                handoff.commit();
                successor.activate();
                delivery.resolve();
              } catch (error) {
                delivery.reject(error);
                throw error;
              }
              if (!await completion) throw new AgentCallError('rejected', 'Goal control was not delivered');
            },
          };
          const ref = preparations.add(preparation);
          const retirePreparation = () => {
            if (!pending) return;
            pending = false;
            preparations.delete(ref);
            if (preparation.timer) clearTimeout(preparation.timer);
            successor.releasePreparation();
            delivery.reject(new AgentCallError('rejected', 'Goal preparation expired or interrupted', 'STALE_RESOURCE'));
          };
          preparation.timer = setTimeout(() => {
            retirePreparation();
          }, PREPARATION_TIMEOUT_MS);
          preparation.timer.unref();
          reserved = true;
          successor.expose(retirePreparation);
          prepared.resolve({ preparation: ref, handle: successor.handle });
          await delivery.promise;
        },
      }, successor.publish);
      void completion.then((handled) => {
        successor.settle(handled ? undefined : new AgentCallError('rejected', 'Goal control was not delivered'));
        if (!reserved) {
          successor.abandon();
          if (handled) prepared.reject(new Error('Goal control delivered without preparation'));
          else prepared.resolve(null);
        }
      }, (error) => {
        successor.settle(error);
        if (!reserved) successor.abandon();
        prepared.reject(error);
      });
      return prepared.promise;
    },
    async deliverControl(ref, options) {
      options?.signal?.throwIfAborted();
      const preparation = preparations.take(ref);
      if (preparation.timer) clearTimeout(preparation.timer);
      await preparation.deliver();
    },
    async cancelControl(ref) {
      const preparation = preparations.take(ref);
      if (preparation.timer) clearTimeout(preparation.timer);
      preparation.cancel();
    },
  };
}

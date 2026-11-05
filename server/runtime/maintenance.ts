import { AgentCallError, type AgentExecutionContextV5, type AgentIntegration } from '@garcon/server-agent-interface';
import { GitServiceError } from '../../common/git-error.js';
import { waitAbortably } from '../common/abortable-wait.js';

// Removal is rare; executor-wide exclusion avoids a second project ownership index.
export class RuntimeMaintenance {
  #removing = false;
  #pending = 0;
  #uncertain = false;
  readonly #runs = new Set<object>();
  readonly #wrapped = new WeakMap<AgentIntegration, AgentIntegration>();

  integration(source: AgentIntegration): AgentIntegration {
    const cached = this.#wrapped.get(source);
    if (cached) return cached;
    const runs = new Map<string, { bindingId: string }>();
    source.producers.subscribe(({ binding, event }) => {
      if (event.type !== 'run-ended') return;
      const run = runs.get(event.runId);
      const commandExited = event.commandOutcome?.outcome === 'failed'
        && event.commandOutcome.exitCode !== null && event.commandOutcome.signal === null;
      // Provider failures can precede native teardown; a structured command exit is independent evidence.
      if (event.outcome === 'interrupted' || event.outcome === 'failed'
        && (event.error?.code === 'OUTCOME_UNKNOWN' || !commandExited)) this.#uncertain = true;
      if (run?.bindingId === binding.id) { this.#runs.delete(run); runs.delete(event.runId); }
    });
    const admitRun = <T>(request: AgentExecutionContextV5, run: () => Promise<T>) => this.#admit(async () => {
      const reservation = { bindingId: request.producerBinding.id };
      if (runs.has(request.runId)) throw new AgentCallError('not-dispatched', 'Native run already admitted.');
      runs.set(request.runId, reservation); this.#runs.add(reservation);
      try { return await run(); }
      catch (error) {
        if (!(error instanceof AgentCallError) || error.outcome === 'unknown') this.#uncertain = true;
        if (runs.get(request.runId) === reservation) runs.delete(request.runId);
        this.#runs.delete(reservation);
        throw error;
      }
    });
    const execution = { ...source.execution,
      start: (...args: Parameters<typeof source.execution.start>) => admitRun(args[0], () => source.execution.start(...args)),
      resume: (...args: Parameters<typeof source.execution.resume>) => admitRun(args[0], () => source.execution.resume(...args)),
      abort: (...args: Parameters<typeof source.execution.abort>) => {
        // Stop acknowledges control, not native process exit; providers expose no quiescence facet.
        this.#uncertain = true;
        return source.execution.abort(...args);
      },
      runningSessions: (...args: Parameters<typeof source.execution.runningSessions>) => source.execution.runningSessions(...args),
    } satisfies AgentIntegration['execution'];
    const compaction = source.compaction && { compact: (...args: Parameters<NonNullable<AgentIntegration['compaction']>['compact']>) => admitRun(args[0], () => source.compaction!.compact(...args)) } satisfies NonNullable<AgentIntegration['compaction']>;
    const singleQuery = source.singleQuery && { ...(source.singleQuery.runsToolsWithoutPermission ? { runsToolsWithoutPermission: true as const } : {}),
      run: (...args: Parameters<NonNullable<AgentIntegration['singleQuery']>['run']>) => this.#admit(async () => {
        args[0].signal.throwIfAborted();
        try { return await source.singleQuery!.run(...args); }
        catch (error) {
          // Provider cancellation may race native teardown without a delivery-outcome error.
          if (!(error instanceof AgentCallError) || error.outcome === 'unknown') this.#uncertain = true;
          throw error;
        }
      }) } satisfies NonNullable<AgentIntegration['singleQuery']>;
    const producers = { scope: source.producers.scope,
      bind: (...args: Parameters<typeof source.producers.bind>) => source.producers.bind(...args),
      subscribe: (...args: Parameters<typeof source.producers.subscribe>) => source.producers.subscribe(...args),
      detach: (...args: Parameters<typeof source.producers.detach>) => source.producers.detach(...args),
      close: (...args: Parameters<typeof source.producers.close>) => {
        if ([...runs.values()].some(run => run.bindingId === args[0].id)) this.#uncertain = true;
        return source.producers.close(...args);
      },
    } satisfies AgentIntegration['producers'];
    const nativeSessions = source.nativeSessions && {
      resolveNativeSession: (...args: Parameters<NonNullable<AgentIntegration['nativeSessions']>['resolveNativeSession']>) => source.nativeSessions!.resolveNativeSession(...args),
      describeSource: (...args: Parameters<NonNullable<AgentIntegration['nativeSessions']>['describeSource']>) => source.nativeSessions!.describeSource(...args),
      release: (...args: Parameters<NonNullable<AgentIntegration['nativeSessions']>['release']>) => {
        this.#uncertain = true; return source.nativeSessions!.release(...args);
      },
    } satisfies NonNullable<AgentIntegration['nativeSessions']>;
    const lifecycle = {
      start: () => source.lifecycle.start(), migrateOwnedStorage: () => source.lifecycle.migrateOwnedStorage(),
      stop: () => { this.#uncertain = true; return source.lifecycle.stop(); },
    } satisfies AgentIntegration['lifecycle'];
    const projectPathUpdates = source.projectPathUpdates && {
      prepare: (...args: Parameters<NonNullable<AgentIntegration['projectPathUpdates']>['prepare']>) => this.#admit(() => source.projectPathUpdates!.prepare(...args)),
      commit: (...args: Parameters<NonNullable<AgentIntegration['projectPathUpdates']>['commit']>) => this.#admit(() => source.projectPathUpdates!.commit(...args)),
      rollback: (...args: Parameters<NonNullable<AgentIntegration['projectPathUpdates']>['rollback']>) => source.projectPathUpdates!.rollback(...args),
    } satisfies NonNullable<AgentIntegration['projectPathUpdates']>;
    const forking = source.forking && {
      fork: (...args: Parameters<NonNullable<AgentIntegration['forking']>['fork']>) => this.#admit(() => source.forking!.fork(...args)),
      discard: (...args: Parameters<NonNullable<AgentIntegration['forking']>['discard']>) => this.#admit(() => source.forking!.discard(...args)),
    } satisfies NonNullable<AgentIntegration['forking']>;
    const steering = source.steering && {
      captureTarget: (...args: Parameters<NonNullable<AgentIntegration['steering']>['captureTarget']>) => source.steering!.captureTarget(...args),
      steer: (...args: Parameters<NonNullable<AgentIntegration['steering']>['steer']>) => this.#admit(async () => {
        const result = await source.steering!.steer(...args);
        if (result.kind === 'failed' && result.outcome === 'unknown') this.#uncertain = true;
        return result;
      }),
    } satisfies NonNullable<AgentIntegration['steering']>;
    const overrides = { execution, producers, nativeSessions, lifecycle, compaction, singleQuery, projectPathUpdates, forking, steering };
    const wrapped = new Proxy(source, { get(target, key) {
      return Object.hasOwn(overrides, key) ? overrides[key as keyof typeof overrides] : Reflect.get(target, key, target);
    } });
    this.#wrapped.set(source, wrapped);
    return wrapped;
  }

  reserveMutation(): () => void {
    if (this.#removing) throw new AgentCallError('not-dispatched', 'Executor is removing a managed repository resource.');
    this.#pending++;
    return () => { this.#pending--; };
  }

  async #admit<T>(run: () => Promise<T>): Promise<T> {
    if (this.#removing) throw new AgentCallError('not-dispatched', 'Executor is removing a managed repository resource.');
    this.#pending++;
    try { return await run(); }
    catch (error) {
      if (!(error instanceof AgentCallError) || error.outcome === 'unknown') this.#uncertain = true;
      throw error;
    } finally { this.#pending--; }
  }

  async remove<T>(integrations: readonly AgentIntegration[], reserveTerminals: () => () => void,
    run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#uncertain) throw new GitServiceError('GIT_SERVICE_BUSY', 'Native writer termination is uncertain. Repeating cleanup cannot establish safety; manual recovery is required.');
    if (this.#removing || this.#pending || this.#runs.size) throw new GitServiceError('GIT_SERVICE_BUSY', 'Executor has pending native work.');
    this.#removing = true;
    let releaseTerminals: (() => void) | undefined;
    try {
      try {
        releaseTerminals = reserveTerminals();
        for (const integration of integrations) {
          signal?.throwIfAborted();
          const sessions = integration.execution.runningSessions({ signal });
          if ((await (signal ? waitAbortably(sessions, signal) : sessions)).length) {
            throw new GitServiceError('GIT_SERVICE_BUSY', 'Executor has active native work.');
          }
        }
        signal?.throwIfAborted();
        if (this.#pending || this.#runs.size || this.#uncertain) throw new GitServiceError('GIT_SERVICE_BUSY', 'Native writer status changed.');
      } catch {
        throw new GitServiceError('GIT_SERVICE_BUSY', 'Executor writer quiescence could not be established; removal was not started.');
      }
      return await run();
    } finally { releaseTerminals?.(); this.#removing = false; }
  }
}

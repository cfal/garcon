import {
  AgentCallError,
  type AgentExecutionHandle,
  type AgentIntegration,
  type AgentProducerBinding,
  type AgentProducerNotification,
} from '@garcon/server-agent-interface';
import { failureDetail } from '@garcon/server-agent-common/execution/producer-adapter';
import type { ObserveUndeliveredReply } from '../transport/rpc.js';
import type { AgentProducerFrame, ProducerAcknowledgement, ProducerResumeState } from '../transport/rpc-protocol.js';
import { SESSION_MESSAGE_BYTES } from '../transport/session-socket.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START } from '../../common/executor-disconnect.js';

// Matches the controller's reconnect grace and VS Code Remote's reconnection
// grace; after it, the controller fails the run and this worker detaches the
// binding. https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/base/parts/ipc/common/ipc.net.ts#L301-L308
const PRODUCER_RESUME_GRACE_MS = 3 * 60 * 60 * 1000;
// A controller resumes every binding it still holds while installing a new
// session, so bindings still suspended this long after one starts belong to a
// controller that restarted or gave up. VS Code shortens its grace the same way
// once another client connects: https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/server/node/remoteExtensionHostAgentServer.ts#L381-L391
const PRODUCER_SUPERSEDED_GRACE_MS = 5 * 60 * 1000;
// Bounds worker memory across all bindings. Replay is paced by the session
// queue, so the backlog need not fit that queue.
const RETAINED_BYTES = 32 * 1024 * 1024;
const PUMP_RETRY_MS = 10;
// A chat launches one run at a time, so only its latest launches can have lost
// their requests with a session.
const RECEIVED_LAUNCHES = 8;

export interface ProducerRelaySession {
  // Returns false when the session cannot take the frame now; the relay keeps
  // it and offers it again as the session drains.
  offer(payload: string): boolean;
}

interface RetainedFrame {
  readonly seq: number;
  // Relay-wide publication order, which the pump preserves across bindings.
  readonly order: number;
  readonly payload: string;
  readonly bytes: number;
  // Only row batches are dropped under pressure; session, permission, and run
  // facts are small and keep the controller's run state coherent.
  readonly droppable: boolean;
}

interface RelayedLaunch {
  readonly runId: string;
  // Null until the launch returns.
  handle: AgentExecutionHandle | null;
  // Cancels native admission once the controller abandons a launch whose call
  // it lost, or a newer launch replaces it on the binding.
  readonly cancellation: AbortController;
}

interface RelayedBinding {
  readonly integration: AgentIntegration;
  readonly ref: AgentProducerBinding;
  seq: number;
  readonly retained: RetainedFrame[];
  // Leading retained frames already handed to `session`.
  sent: number;
  retainedBytes: number;
  session: ProducerRelaySession | null;
  grace: { readonly timer: ReturnType<typeof setTimeout>; readonly deadline: number } | null;
  // The latest launch until its run ends or it fails, reported on resume.
  launch: RelayedLaunch | null;
  // Run IDs of the latest launches received, oldest first, reported on resume
  // so the controller relaunches only a request the worker never received.
  readonly received: string[];
}

interface UnsentFrame {
  readonly binding: RelayedBinding;
  readonly session: ProducerRelaySession;
  readonly frame: RetainedFrame;
}

type LaunchSettled = Extract<AgentProducerNotification['event'], { readonly type: 'launch-settled' }>;

export interface ProducerRelayOptions {
  readonly graceMs?: number;
  readonly supersededGraceMs?: number;
  readonly retainedBytes?: number;
}

// Delivers producer notifications for one worker process across controller
// sessions, following VS Code's persistent protocol: frames stay retained until
// acknowledged, and a resumed binding resends every unacknowledged frame ahead
// of newer output (https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/base/parts/ipc/common/ipc.net.ts#L974-L989).
// VS Code's socket buffers without limit; the session queue here is bounded, so
// frames reach it in publication order only as fast as it drains. A lost
// session suspends its bindings for a grace period instead of detaching them.
// When the retention budget overflows, the oldest row batches are dropped and
// the controller sees the skipped sequence numbers as a delivery gap. A launch
// whose reply is lost with its session reaches the controller the same way:
// the resume reply reports each binding's latest launch, and a launch that
// settles after its session was lost publishes its outcome on the binding. The
// reply also lists the launches received, so the controller can send again one
// whose request never arrived.
export class ProducerRelay {
  readonly #bindings = new Map<string, RelayedBinding>();
  readonly #subscriptions = new Map<AgentIntegration, () => void>();
  readonly #graceMs: number;
  readonly #supersededGraceMs: number;
  readonly #retainedLimit: number;
  #retainedBytes = 0;
  #published = 0;
  #pumping = false;
  #pumpRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProducerRelayOptions = {}) {
    this.#graceMs = options.graceMs ?? PRODUCER_RESUME_GRACE_MS;
    this.#supersededGraceMs = options.supersededGraceMs ?? PRODUCER_SUPERSEDED_GRACE_MS;
    this.#retainedLimit = options.retainedBytes ?? RETAINED_BYTES;
  }

  track(integration: AgentIntegration): void {
    if (this.#subscriptions.has(integration)) return;
    this.#subscriptions.set(integration, integration.producers.subscribe((notification) => {
      this.#publish(integration, notification);
    }));
  }

  bind(session: ProducerRelaySession, integration: AgentIntegration, ref: AgentProducerBinding): void {
    this.#bindings.set(ref.id, {
      integration, ref, seq: 0, retained: [], sent: 0, retainedBytes: 0, session, grace: null, launch: null, received: [],
    });
  }

  // Runs a start, resume, or compaction dispatched by `session`. Its outcome is
  // published on the binding only when its reply cannot reach the controller:
  // the session was lost, or the session could not take the reply. `signal` is
  // the call's, which the controller aborts when its caller gives up; losing the
  // session does not abort it, so `run` also observes the launch's own
  // cancellation.
  async launch(
    session: ProducerRelaySession,
    integration: AgentIntegration,
    request: { readonly producerBinding: AgentProducerBinding; readonly runId: string },
    signal: AbortSignal,
    onUndeliveredReply: ObserveUndeliveredReply,
    run: (signal: AbortSignal) => Promise<AgentExecutionHandle>,
  ): Promise<AgentExecutionHandle> {
    const binding = this.#bindings.get(request.producerBinding.id);
    if (binding?.integration !== integration) return runLaunch(() => run(signal));
    binding.received.push(request.runId);
    if (binding.received.length > RECEIVED_LAUNCHES) binding.received.shift();
    // The controller begins another run on a binding only after abandoning the previous one.
    if (binding.launch && !binding.launch.handle) binding.launch.cancellation.abort();
    const launch: RelayedLaunch = { runId: request.runId, handle: null, cancellation: new AbortController() };
    binding.launch = launch;
    const publishIfReplyLost = (event: LaunchSettled) => {
      const publish = () => this.#publish(integration, { binding: binding.ref, event });
      if (binding.session === session) onUndeliveredReply(publish);
      else publish();
    };
    let handle: AgentExecutionHandle;
    try {
      handle = await runLaunch(() => run(AbortSignal.any([signal, launch.cancellation.signal])));
      if (launch.cancellation.signal.aborted) {
        // Admission finished despite the cancellation, leaving a turn no one owns.
        void integration.execution.abort(handle).catch(() => undefined);
        throw new AgentCallError('rejected', 'The launch was cancelled before it started.');
      }
    } catch (error) {
      if (binding.launch === launch) {
        binding.launch = null;
        // Losing its session does not cancel a launch, so a failure is its own unless
        // the launch was cancelled before it started. A nested call the loss cut
        // off, such as a credential read, fails with its own error.
        const cancelled = signal.aborted || launch.cancellation.signal.aborted;
        publishIfReplyLost({
          type: 'launch-settled',
          runId: launch.runId,
          error: cancelled && binding.session !== session ? EXECUTOR_DISCONNECTED_BEFORE_START : failureDetail(error),
        });
      }
      throw error;
    }
    if (binding.launch === launch) {
      launch.handle = handle;
      publishIfReplyLost({ type: 'launch-settled', runId: launch.runId, handle });
    }
    return handle;
  }

  // The controller abandoned a launch whose call it lost. One that already
  // returned is aborted through its handle once the controller learns it.
  cancelLaunch(integration: AgentIntegration, ref: AgentProducerBinding, runId: string): void {
    const binding = this.#bindings.get(ref.id);
    if (binding?.integration !== integration) return;
    if (binding.launch?.runId === runId && !binding.launch.handle) binding.launch.cancellation.abort();
  }

  owns(session: ProducerRelaySession, integration: AgentIntegration, ref: AgentProducerBinding): boolean {
    const binding = this.#bindings.get(ref.id);
    return binding?.integration === integration && binding.session === session;
  }

  // A suspended binding waits, without a session, for one to resume it.
  suspended(integration: AgentIntegration, ref: AgentProducerBinding): boolean {
    const binding = this.#bindings.get(ref.id);
    return binding?.integration === integration && binding.session === null;
  }

  close(ref: AgentProducerBinding): void {
    const binding = this.#bindings.get(ref.id);
    if (binding) this.#forget(binding);
  }

  suspend(session: ProducerRelaySession): void {
    for (const binding of this.#bindings.values()) {
      if (binding.session !== session) continue;
      binding.session = null;
      binding.sent = 0;
      this.#expireWithin(binding, this.#graceMs);
    }
  }

  // Called when a new controller session starts; it never extends a deadline.
  shortenSuspendedGrace(): void {
    for (const binding of this.#bindings.values()) {
      if (!binding.session) this.#expireWithin(binding, this.#supersededGraceMs);
    }
  }

  // Frames that do not fit the session queue now follow the reply.
  resume(
    session: ProducerRelaySession,
    integration: AgentIntegration,
    requests: readonly { readonly binding: AgentProducerBinding; readonly acknowledgedSeq: number }[],
  ): ProducerResumeState[] {
    const resumed: ProducerResumeState[] = [];
    for (const { binding: ref, acknowledgedSeq } of requests) {
      const binding = this.#bindings.get(ref.id);
      if (binding?.integration !== integration) continue;
      if (binding.grace) clearTimeout(binding.grace.timer);
      binding.grace = null;
      binding.session = session;
      this.#release(binding, acknowledgedSeq);
      binding.sent = 0;
      resumed.push({
        bindingId: ref.id,
        replayThroughSeq: this.#pinReplayTail(binding, acknowledgedSeq),
        launch: binding.launch && { runId: binding.launch.runId, handle: binding.launch.handle },
        receivedRunIds: [...binding.received],
      });
    }
    this.#pump();
    return resumed;
  }

  // The controller settles lost launches once its replay reaches the returned
  // sequence, so the frame carrying it must survive the pressure that drops
  // older rows. Rows already dropped from the tail are never replayed, so the
  // replay ends at the last frame still retained.
  #pinReplayTail(binding: RelayedBinding, acknowledgedSeq: number): number {
    const index = binding.retained.length - 1;
    const tail = binding.retained[index];
    if (!tail) return acknowledgedSeq;
    if (tail.droppable) binding.retained[index] = { ...tail, droppable: false };
    return tail.seq;
  }

  acknowledge(session: ProducerRelaySession, acknowledgements: readonly ProducerAcknowledgement[]): void {
    for (const { bindingId, seq } of acknowledgements) {
      const binding = this.#bindings.get(bindingId);
      if (binding?.session === session) this.#release(binding, seq);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    for (const binding of this.#bindings.values()) {
      if (binding.grace) clearTimeout(binding.grace.timer);
    }
    this.#bindings.clear();
    this.#retainedBytes = 0;
    if (this.#pumpRetry) clearTimeout(this.#pumpRetry);
    this.#pumpRetry = null;
  }

  #publish(integration: AgentIntegration, notification: AgentProducerNotification): void {
    const binding = this.#bindings.get(notification.binding.id);
    if (binding?.integration !== integration) return;
    const { event } = notification;
    if (event.type === 'run-ended' && binding.launch?.runId === event.runId) binding.launch = null;
    binding.seq += 1;
    this.#published += 1;
    const payload = encodeProducerFrame(binding.seq, notification);
    const frame: RetainedFrame = {
      seq: binding.seq,
      order: this.#published,
      payload,
      bytes: Buffer.byteLength(payload),
      droppable: notification.event.type === 'rows',
    };
    binding.retained.push(frame);
    binding.retainedBytes += frame.bytes;
    this.#retainedBytes += frame.bytes;
    while (this.#retainedBytes > this.#retainedLimit) {
      if (!this.#dropOldestRows(frame)) break;
    }
    if (binding.session) this.#pump();
  }

  // Offers unsent frames in publication order until a session refuses one,
  // then retries as the session queue drains.
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let next = this.#nextUnsent(); next; next = this.#nextUnsent()) {
        const accepted = next.session.offer(next.frame.payload);
        // A session that fails while taking the frame has already suspended the binding.
        if (next.binding.session !== next.session) continue;
        if (!accepted) {
          if (!this.#pumpRetry) {
            this.#pumpRetry = setTimeout(() => { this.#pumpRetry = null; this.#pump(); }, PUMP_RETRY_MS);
            this.#pumpRetry.unref?.();
          }
          return;
        }
        next.binding.sent += 1;
      }
    } finally { this.#pumping = false; }
  }

  // The earliest-published frame not yet handed to its binding's session.
  #nextUnsent(): UnsentFrame | null {
    let next: UnsentFrame | null = null;
    for (const binding of this.#bindings.values()) {
      const frame = binding.retained[binding.sent];
      if (!binding.session || !frame) continue;
      if (!next || frame.order < next.frame.order) next = { binding, session: binding.session, frame };
    }
    return next;
  }

  // Drops from the largest backlog first; the newest frame is kept even when it
  // alone overshoots the budget, which bounds the overshoot by one frame.
  #dropOldestRows(newest: RetainedFrame): boolean {
    const backlogs = [...this.#bindings.values()].sort((left, right) => right.retainedBytes - left.retainedBytes);
    for (const binding of backlogs) {
      const index = binding.retained.findIndex((frame) => frame.droppable && frame !== newest);
      if (index < 0) continue;
      const [dropped] = binding.retained.splice(index, 1);
      if (index < binding.sent) binding.sent -= 1;
      binding.retainedBytes -= dropped!.bytes;
      this.#retainedBytes -= dropped!.bytes;
      return true;
    }
    return false;
  }

  #release(binding: RelayedBinding, seq: number): void {
    const firstKept = binding.retained.findIndex((frame) => frame.seq > seq);
    const released = binding.retained.splice(0, firstKept < 0 ? binding.retained.length : firstKept);
    for (const frame of released) {
      binding.retainedBytes -= frame.bytes;
      this.#retainedBytes -= frame.bytes;
    }
    binding.sent = Math.max(0, binding.sent - released.length);
  }

  #expireWithin(binding: RelayedBinding, graceMs: number): void {
    const deadline = performance.now() + graceMs;
    if (binding.grace && binding.grace.deadline <= deadline) return;
    if (binding.grace) clearTimeout(binding.grace.timer);
    const timer = setTimeout(() => this.#expire(binding), graceMs);
    timer.unref?.();
    binding.grace = { timer, deadline };
  }

  #expire(binding: RelayedBinding): void {
    if (this.#bindings.get(binding.ref.id) !== binding || binding.session) return;
    this.#forget(binding);
    binding.integration.producers.detach(binding.ref);
  }

  #forget(binding: RelayedBinding): void {
    if (binding.grace) clearTimeout(binding.grace.timer);
    this.#bindings.delete(binding.ref.id);
    this.#retainedBytes -= binding.retainedBytes;
  }
}

// A launch that throws returns no handle, so the controller has no report to wait
// for. An unknown outcome it carries belongs to a nested call, such as a
// credential read, and must not reach the controller as a lost launch reply.
async function runLaunch(run: () => Promise<AgentExecutionHandle>): Promise<AgentExecutionHandle> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgentCallError && error.outcome === 'unknown') {
      throw new AgentCallError('rejected', error.message, error.code);
    }
    throw error;
  }
}

function encodeProducerFrame(seq: number, notification: AgentProducerNotification): string {
  const payload = JSON.stringify({ type: 'producer', seq, notification } satisfies AgentProducerFrame);
  if (Buffer.byteLength(payload) <= SESSION_MESSAGE_BYTES) return payload;
  return JSON.stringify({
    type: 'producer', seq, notification: {
      binding: notification.binding,
      event: { type: 'publication-failed', error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'Provider output exceeds the executor message size limit. Native history may contain additional output.',
      } },
    },
  } satisfies AgentProducerFrame);
}

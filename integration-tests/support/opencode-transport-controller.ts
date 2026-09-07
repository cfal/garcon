// Test-side control of the supervisor's optional reverse proxy. The controller appends
// directives (hold selected stream frames or HTTP responses, release them, or reset an exact
// active global connection) and waits on proxy observations; both files are atomic JSON snapshots
// below the fixture proxy directory. Tests synchronize on observed state, never on guessed sleeps.

import { join } from 'node:path';
import type { IntegrationDirectories } from './integration-fixture.js';
import { openCodePaths } from './scripted-opencode.js';
import { readJsonFile, writeJsonAtomic } from './opencode-process-supervisor.js';

interface TransportDirective {
  seq: number;
  action: 'hold' | 'hold-through-markers' | 'release' | 'reset'
    | 'hold-response' | 'release-response';
  connectionId?: number;
  responseId?: number;
  path?: string;
  startMarker?: string;
  endMarker?: string;
}

interface TransportDirectives {
  directives: TransportDirective[];
}

export interface GlobalConnectionObservation {
  id: number;
  path: string;
  held: boolean;
  released: boolean;
  markerHeld: boolean;
  endMarkerObserved: boolean;
  reset: boolean;
  closed: boolean;
}

export interface HeldResponseObservation {
  id: number;
  path: string;
  held: boolean;
  released: boolean;
  closed: boolean;
}

interface TransportObservations {
  appliedSeq: number;
  requests: Array<{ method: string; path: string }>;
  connections: GlobalConnectionObservation[];
  responses: HeldResponseObservation[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 15;

export class OpenCodeTransportController {
  readonly #directivesPath: string;
  readonly #observationsPath: string;
  #seq = 0;

  private constructor(proxyDir: string) {
    this.#directivesPath = join(proxyDir, 'directives.json');
    this.#observationsPath = join(proxyDir, 'observations.json');
  }

  static forFixture(directories: IntegrationDirectories): OpenCodeTransportController {
    return new OpenCodeTransportController(openCodePaths(directories).proxy);
  }

  // Resolves once the proxy has applied the hold, so the next global stream is held
  // deterministically rather than racily.
  async holdNextConnectedFrame(): Promise<void> {
    const seq = await this.#append({ action: 'hold' });
    await this.#waitForObservation(
      (observations) => observations.appliedSeq >= seq ? observations.appliedSeq : null,
      `hold directive ${seq} was never applied`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  // Resolves once the proxy holds the real server.connected frame of the next global stream.
  async waitForConnectedFrameHeld(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    const connection = await this.#waitForObservation(
      (observations) => observations.connections.find((entry) => entry.held && !entry.released),
      'the connected frame was never held',
      timeoutMs,
    );
    return connection.id;
  }

  async releaseConnectedFrame(connectionId: number): Promise<void> {
    await this.releaseGlobalConnection(connectionId);
  }

  async holdGlobalStreamThroughMarkers(
    connectionId: number,
    startMarker: string,
    endMarker: string,
  ): Promise<void> {
    const seq = await this.#append({
      action: 'hold-through-markers',
      connectionId,
      startMarker,
      endMarker,
    });
    await this.#waitForObservation(
      (observations) => observations.appliedSeq >= seq ? observations.appliedSeq : null,
      `marker hold directive ${seq} was never applied`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async waitForStartMarkerHeld(connectionId: number): Promise<void> {
    await this.#waitForObservation(
      (observations) => observations.connections.find(
        (entry) => entry.id === connectionId && entry.markerHeld,
      ),
      `connection ${connectionId} never held the start marker`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async waitForEndMarkerBuffered(connectionId: number): Promise<void> {
    await this.#waitForObservation(
      (observations) => observations.connections.find(
        (entry) => entry.id === connectionId && entry.endMarkerObserved,
      ),
      `connection ${connectionId} never buffered the end marker`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async releaseGlobalConnection(connectionId: number): Promise<void> {
    await this.#append({ action: 'release', connectionId });
    await this.#waitForObservation(
      (observations) => observations.connections.find(
        (entry) => entry.id === connectionId && entry.released,
      ),
      `connection ${connectionId} was never released`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async activeGlobalConnectionId(): Promise<number> {
    const connection = await this.#waitForObservation(
      (observations) => observations.connections.filter((entry) => !entry.closed).at(-1),
      'no active global connection was observed',
      DEFAULT_TIMEOUT_MS,
    );
    return connection.id;
  }

  async resetGlobalConnection(connectionId: number): Promise<void> {
    await this.#append({ action: 'reset', connectionId });
    await this.#waitForObservation(
      (observations) => observations.connections.find(
        (entry) => entry.id === connectionId && entry.reset,
      ),
      `connection ${connectionId} was never reset`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async holdNextResponse(path: string): Promise<void> {
    const seq = await this.#append({ action: 'hold-response', path });
    await this.#waitForObservation(
      (observations) => observations.appliedSeq >= seq ? observations.appliedSeq : null,
      `response hold directive ${seq} was never applied`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async waitForResponseHeld(path: string): Promise<number> {
    const response = await this.#waitForObservation(
      (observations) => observations.responses.find(
        (entry) => entry.path === path && entry.held && !entry.released,
      ),
      `response for ${path} was never held`,
      DEFAULT_TIMEOUT_MS,
    );
    return response.id;
  }

  async releaseResponse(responseId: number): Promise<void> {
    await this.#append({ action: 'release-response', responseId });
    await this.#waitForObservation(
      (observations) => observations.responses.find(
        (entry) => entry.id === responseId && entry.released,
      ),
      `response ${responseId} was never released`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async waitForGlobalConnectionCount(
    count: number,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    await this.#waitForObservation(
      (observations) => observations.connections.length >= count
        ? observations.connections
        : null,
      `only ${(await this.#observations())?.connections.length ?? 0} global connection(s) observed`,
      timeoutMs,
    );
  }

  async requests(): Promise<Array<{ method: string; path: string }>> {
    return (await this.#observations())?.requests ?? [];
  }

  async waitForRequest(method: string, pathPrefix: string): Promise<{ method: string; path: string }> {
    return this.#waitForObservation(
      (observations) => observations.requests.find(
        (request) => request.method === method && request.path.startsWith(pathPrefix),
      ),
      `${method} request below ${pathPrefix} was never observed`,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async connections(): Promise<GlobalConnectionObservation[]> {
    return (await this.#observations())?.connections ?? [];
  }

  async #append(directive: Omit<TransportDirective, 'seq'>): Promise<number> {
    const current = await readJsonFile<TransportDirectives>(this.#directivesPath)
      ?? { directives: [] };
    this.#seq = Math.max(this.#seq, ...current.directives.map((entry) => entry.seq), 0) + 1;
    current.directives.push({ ...directive, seq: this.#seq });
    await writeJsonAtomic(this.#directivesPath, current);
    return this.#seq;
  }

  async #observations(): Promise<TransportObservations | null> {
    return readJsonFile<TransportObservations>(this.#observationsPath);
  }

  async #waitForObservation<T>(
    pick: (observations: TransportObservations) => T | null | undefined,
    failure: string,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const observations = await this.#observations();
      if (observations) {
        const picked = pick(observations);
        if (picked) return picked;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`OpenCode transport observation timed out: ${failure}.`);
  }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  NODE_ENROLLMENT_TTL_MS, isPairingTimestamp, parseNodeEnrollmentRequest, parsePairingSecret,
  type NodeEnrollmentRequest, type NodeEnrollmentResponse,
} from '../../common/execution-node-config.js';
import { isExecutionIdentity } from '../../common/execution-location.js';
import { isRecord } from '../../common/json.js';
import { DomainError } from '../lib/domain-error.js';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';

export const MAX_PENDING_NODE_ENROLLMENTS = 32;
export const MAX_PAIRED_NODE_IDENTITIES = 1024;

interface Enrollment {
  readonly id: string;
  readonly nodeId: string;
  readonly verifier: string;
  readonly expiresAt: string;
}

interface PairingState {
  readonly version: 1;
  readonly controllerId: string;
  readonly nodes: readonly { readonly nodeId: string; readonly verifier: string | null }[];
  readonly enrollments: readonly Enrollment[];
}

export interface IssuedNodeEnrollment extends NodeEnrollmentRequest {
  readonly expiresAt: string;
}

export interface PairedNodePrincipal {
  readonly controllerId: string;
  readonly nodeId: string;
}

export interface PairedNodeConnection {
  readonly principal: PairedNodePrincipal;
  validate(): void;
}

/** Owns credential authority only. Resource registrations and grants stay in the node directory. */
export class NodePairingStore {
  readonly #filePath: string;
  readonly #lock = new KeyedPromiseLock();
  readonly #write: typeof writeJsonFileAtomic;
  readonly #now: () => number;
  #snapshot: PairingState | null = null;
  #uncertain = false;
  #writing = false;
  readonly #credentialLifetimes = new Map<string, AbortController>();
  readonly #pendingRevocations = new Map<string, number>();

  constructor(workspaceDirectory: string, options: { write?: typeof writeJsonFileAtomic; now?: () => number } = {}) {
    this.#filePath = join(workspaceDirectory, 'execution-node-pairing.json');
    this.#write = options.write ?? writeJsonFileAtomic;
    this.#now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    await this.#lock.runExclusive(this.#filePath, async () => {
      this.#assertCertain();
      if (this.#snapshot) return;
      const loaded = await readJsonStateFile<PairingState | null>({
        filePath: this.#filePath, empty: () => null,
        normalize: (value) => {
          const parsed = parsePairingState(value);
          if (!parsed) throw new Error('Invalid execution node pairing state');
          return parsed;
        },
      });
      if (loaded) this.#snapshot = loaded;
      else await this.#commit({ version: 1, controllerId: randomUUID(), nodes: [], enrollments: [] });
    });
  }

  get controllerId(): string {
    return this.#current().controllerId;
  }

  async issueEnrollment(nodeId: string, authorize: () => Promise<void> = async () => {}): Promise<IssuedNodeEnrollment> {
    if (!isExecutionIdentity(nodeId)) throw new TypeError('Invalid enrollment node identity');
    return this.#lock.runExclusive(this.#filePath, async () => {
      await authorize();
      this.#requireUnrevoked(nodeId);
      const current = this.#current();
      const now = this.#time();
      const enrollments = current.enrollments.filter((entry) => entry.nodeId !== nodeId && Date.parse(entry.expiresAt) > now);
      const pendingNodes = new Set(enrollments.map((entry) => entry.nodeId));
      // Stable identities belong to the node directory, not expired credential records.
      const nodes = current.nodes.filter((entry) => entry.verifier !== null || entry.nodeId === nodeId || pendingNodes.has(entry.nodeId));
      const node = nodes.find((entry) => entry.nodeId === nodeId);
      if (node?.verifier) throw new DomainError('NODE_ALREADY_PAIRED', 'Revoke this node before pairing it again', 409);
      if (!node && nodes.length >= MAX_PAIRED_NODE_IDENTITIES) {
        throw new DomainError('NODE_PAIRING_CAPACITY', 'The paired node identity limit was reached', 409);
      }
      if (enrollments.length >= MAX_PENDING_NODE_ENROLLMENTS) {
        throw new DomainError('NODE_PAIRING_CAPACITY', 'Too many pending node enrollments', 429, true);
      }
      const id = randomUUID();
      const token = secret('enroll', id);
      const expiresAt = new Date(now + NODE_ENROLLMENT_TTL_MS).toISOString();
      await this.#commitAuthorized(nodeId, {
        ...current,
        nodes: node ? nodes : [...nodes, { nodeId, verifier: null }],
        enrollments: [...enrollments, { id, nodeId, verifier: digest(token).toString('hex'), expiresAt }],
      }, authorize);
      return { version: 1, controllerId: current.controllerId, nodeId, token, expiresAt };
    });
  }

  async enroll(request: NodeEnrollmentRequest, authorize: () => Promise<void> = async () => {}): Promise<NodeEnrollmentResponse> {
    const captured = parseNodeEnrollmentRequest(request);
    if (!captured) throw invalidEnrollment();
    return this.#lock.runExclusive(this.#filePath, async () => {
      await authorize();
      this.#requireUnrevoked(captured.nodeId);
      const current = this.#current();
      if (captured.controllerId !== current.controllerId) throw invalidEnrollment();
      const tokenId = parsePairingSecret(captured.token, 'enroll')!.id;
      const enrollment = current.enrollments.find((entry) => entry.id === tokenId);
      if (!enrollment || enrollment.nodeId !== captured.nodeId || !matches(captured.token, enrollment.verifier)) throw invalidEnrollment();
      if (this.#time() >= Date.parse(enrollment.expiresAt)) {
        throw new DomainError('NODE_ENROLLMENT_EXPIRED', 'Node enrollment expired; request a new bundle', 401);
      }
      const credential = secret('node', enrollment.nodeId);
      await this.#commitAuthorized(captured.nodeId, {
        ...current,
        nodes: current.nodes.map((node) => node.nodeId === enrollment.nodeId
          ? { ...node, verifier: digest(credential).toString('hex') } : node),
        enrollments: current.enrollments.filter((entry) => entry !== enrollment),
      }, authorize);
      return { version: 1, controllerId: current.controllerId, nodeId: enrollment.nodeId, credential };
    });
  }

  authenticate(credential: string): PairedNodePrincipal | null {
    const current = this.#current();
    const parsed = parsePairingSecret(credential, 'node');
    if (!parsed) return null;
    if (this.#pendingRevocations.has(parsed.id)) return null;
    const node = current.nodes.find((entry) => entry.nodeId === parsed.id);
    return node?.verifier && matches(credential, node.verifier)
      ? { controllerId: current.controllerId, nodeId: node.nodeId } : null;
  }

  authenticateConnection(credential: string): PairedNodeConnection | null {
    const principal = this.authenticate(credential);
    if (!principal) return null;
    const verifier = this.#current().nodes.find((entry) => entry.nodeId === principal.nodeId)!.verifier;
    let lifetime = this.#credentialLifetimes.get(principal.nodeId);
    if (!lifetime) {
      lifetime = new AbortController();
      this.#credentialLifetimes.set(principal.nodeId, lifetime);
    }
    const signal = lifetime.signal;
    return Object.freeze({ principal: Object.freeze(principal), validate: () => {
      const current = this.#committed();
      if (signal.aborted || current.controllerId !== principal.controllerId
        || current.nodes.find((entry) => entry.nodeId === principal.nodeId)?.verifier !== verifier) {
        throw new DomainError('NODE_SESSION_EXPIRED', 'Node credential authority is no longer current', 401);
      }
    } });
  }

  async revoke(nodeId: string): Promise<void> {
    if (!isExecutionIdentity(nodeId)) throw new TypeError('Invalid revoked node identity');
    this.#pendingRevocations.set(nodeId, (this.#pendingRevocations.get(nodeId) ?? 0) + 1);
    this.#retireCredential(nodeId);
    try {
      await this.#lock.runExclusive(this.#filePath, async () => {
        const current = this.#current();
        if (!current.nodes.some((entry) => entry.nodeId === nodeId)) return;
        await this.#removePairing(nodeId);
      });
    } finally {
      const remaining = this.#pendingRevocations.get(nodeId)! - 1;
      if (remaining) this.#pendingRevocations.set(nodeId, remaining);
      else this.#pendingRevocations.delete(nodeId);
    }
  }

  #requireUnrevoked(nodeId: string): void {
    if (this.#pendingRevocations.has(nodeId)) throw invalidEnrollment();
  }

  #retireCredential(nodeId: string): void {
    this.#credentialLifetimes.get(nodeId)?.abort();
    this.#credentialLifetimes.delete(nodeId);
  }

  #removePairing(nodeId: string): Promise<void> {
    this.#retireCredential(nodeId);
    const current = this.#committed();
    return this.#commit({
      ...current,
      nodes: current.nodes.filter((entry) => entry.nodeId !== nodeId),
      enrollments: current.enrollments.filter((entry) => entry.nodeId !== nodeId),
    });
  }

  async #commitAuthorized(nodeId: string, candidate: PairingState, authorize: () => Promise<void>): Promise<void> {
    await this.#commit(candidate);
    try {
      await authorize();
      this.#requireUnrevoked(nodeId);
    } catch (error) {
      try {
        await this.#removePairing(nodeId);
      } catch (cleanupError) {
        this.#uncertain = true;
        throw new DomainError('NODE_PAIRING_UNAVAILABLE',
          'Node enrollment authorization changed and credential cleanup failed; restart before issuing a new bundle', 503, false,
          { cause: new AggregateError([error, cleanupError], 'Node enrollment authorization and cleanup failed') });
      }
      throw new DomainError('NODE_PAIRING_UNAVAILABLE',
        'Node enrollment authorization changed during persistence; issue a new bundle', 409, false, { cause: error });
    }
  }

  #current(): PairingState {
    const current = this.#committed();
    if (this.#writing) throw new DomainError('NODE_PAIRING_UNAVAILABLE', 'Node credential mutation is in progress', 503);
    return current;
  }

  #committed(): PairingState {
    this.#assertCertain();
    if (!this.#snapshot) throw new Error('Node pairing is not initialized');
    return this.#snapshot;
  }

  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999 - NODE_ENROLLMENT_TTL_MS) {
      throw new Error('Node enrollment clock is unavailable');
    }
    return now;
  }

  #assertCertain(): void {
    if (this.#uncertain) {
      throw new DomainError('NODE_PAIRING_UNAVAILABLE', 'Node credential durability is unknown; restart before pairing or authenticating nodes', 503);
    }
  }

  async #commit(candidate: PairingState): Promise<void> {
    const normalized = parsePairingState(candidate);
    if (!normalized) throw new TypeError('Invalid execution node pairing state');
    this.#writing = true;
    try {
      await this.#write(this.#filePath, normalized, { mode: 0o600 });
      this.#snapshot = normalized;
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        this.#snapshot = normalized;
        this.#uncertain = true;
      }
      throw error;
    } finally {
      this.#writing = false;
    }
  }
}

function secret(kind: 'enroll' | 'node', id: string): string {
  return `${kind}.${id}.${randomBytes(32).toString('base64url')}`;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function matches(value: string, verifier: string): boolean {
  return timingSafeEqual(digest(value), Buffer.from(verifier, 'hex'));
}

function invalidEnrollment(): DomainError {
  return new DomainError('NODE_ENROLLMENT_INVALID', 'Invalid or already consumed node enrollment', 401);
}

function parsePairingState(value: unknown): PairingState | null {
  if (!isRecord(value) || !keys(value, ['version', 'controllerId', 'nodes', 'enrollments'])
    || value.version !== 1 || !isExecutionIdentity(value.controllerId) || !Array.isArray(value.nodes)
    || value.nodes.length > MAX_PAIRED_NODE_IDENTITIES || !Array.isArray(value.enrollments)
    || value.enrollments.length > MAX_PENDING_NODE_ENROLLMENTS) return null;
  const nodes: PairingState['nodes'][number][] = [];
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!isRecord(node) || !keys(node, ['nodeId', 'verifier']) || !isExecutionIdentity(node.nodeId)
      || nodeIds.has(node.nodeId) || (node.verifier !== null && !isVerifier(node.verifier))) return null;
    nodeIds.add(node.nodeId);
    nodes.push({ nodeId: node.nodeId, verifier: node.verifier });
  }
  const enrollments: Enrollment[] = [];
  const enrolledNodes = new Set<string>();
  const enrollmentIds = new Set<string>();
  for (const enrollment of value.enrollments) {
    if (!isRecord(enrollment) || !keys(enrollment, ['id', 'nodeId', 'verifier', 'expiresAt'])
      || !isExecutionIdentity(enrollment.id) || enrollmentIds.has(enrollment.id)
      || !isExecutionIdentity(enrollment.nodeId) || enrolledNodes.has(enrollment.nodeId)
      || !nodes.some((node) => node.nodeId === enrollment.nodeId && node.verifier === null)
      || !isVerifier(enrollment.verifier) || !isPairingTimestamp(enrollment.expiresAt)) return null;
    enrollmentIds.add(enrollment.id);
    enrolledNodes.add(enrollment.nodeId);
    enrollments.push({ id: enrollment.id, nodeId: enrollment.nodeId, verifier: enrollment.verifier, expiresAt: enrollment.expiresAt });
  }
  return { version: 1, controllerId: value.controllerId, nodes, enrollments };
}

function isVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

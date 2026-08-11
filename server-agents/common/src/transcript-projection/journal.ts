import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseChatMessage } from '@garcon/common/chat-types';
import { stableJsonStringify, type JsonObject } from '@garcon/common/json';
import type {
  AgentOwnershipEpoch,
  AgentSegmentIdentity,
  AgentStreamEvent,
  AgentTranscriptAdmissionIdentity,
  AgentTranscriptContentEpoch,
  AgentTranscriptEntry,
  AgentTranscriptIndexSourceRefV4,
} from '@garcon/server-agent-interface';
import { syncDirectory } from '../lib/json-file-store.js';
import {
  agentTranscriptContentEpoch,
  agentTranscriptEntryId,
  newAgentTranscriptContentEpoch,
  sourceIdentityKey,
} from './identity.js';
import { computeProjectionRevisions } from './revision.js';
import { validateEntries } from './state.js';

const JOURNAL_SCHEMA_VERSION = 1;

interface JournalHeader {
  readonly kind: 'header';
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
}

interface JournalSnapshotRecord {
  readonly kind: 'snapshot';
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly discardedAdmissions: readonly PersistedDiscardedAdmission[];
  readonly nativeRetentionFloor: number;
  readonly aliases: JsonObject;
  readonly handoffCleanupBlocked?: boolean;
}

interface JournalAppendRecord {
  readonly kind: 'append';
  readonly previousDurableRevision: string;
  readonly entries: readonly AgentTranscriptEntry[];
}

interface JournalDiscardRecord {
  readonly kind: 'input-not-sent';
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly durableRevision: string;
  readonly admission: SerializedAdmissionIdentity;
  readonly entryId: string;
}

interface JournalMetadataRecord {
  readonly kind: 'metadata';
  readonly nativeRetentionFloor: number;
  readonly aliases: JsonObject;
}

interface JournalHandoffBoundaryViolationRecord {
  readonly kind: 'handoff-boundary-violation';
  readonly operationId: string;
}

type JournalRecord =
  | JournalHeader
  | JournalSnapshotRecord
  | JournalAppendRecord
  | JournalDiscardRecord
  | JournalMetadataRecord
  | JournalHandoffBoundaryViolationRecord;

type SerializedAdmissionIdentity = Pick<
  AgentTranscriptAdmissionIdentity,
  'agentOwnershipEpoch' | 'clientRequestId' | 'clientMessageId' | 'turnId' | 'commandType' | 'turnOwner'
>;

interface PersistedDiscardedAdmission extends SerializedAdmissionIdentity {
  readonly entryId: string;
}

export interface ProjectionJournalState extends AgentSegmentIdentity {
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly nativeRetentionFloor: number;
  readonly aliases: JsonObject;
  readonly handoffCleanupBlocked: boolean;
}

export interface ProjectionJournalOptions extends AgentSegmentIdentity {
  readonly directory: string;
  readonly bootstrapEntries?: readonly AgentTranscriptEntry[];
  readonly contentEpoch?: AgentTranscriptContentEpoch;
}

export class ProjectionJournalCorruptError extends Error {
  override readonly name = 'ProjectionJournalCorruptError';
}

export class AgentProjectionJournal {
  readonly #filePath: string;
  readonly #discardedAdmissions = new Map<string, { entryId: string; identity: SerializedAdmissionIdentity }>();
  #entries: AgentTranscriptEntry[];
  #contentEpoch: AgentTranscriptContentEpoch;
  #nativeRetentionFloor: number;
  #aliases: JsonObject;
  #handoffCleanupBlocked: boolean;

  private constructor(
    private readonly options: ProjectionJournalOptions,
    state: ProjectionJournalState & {
      readonly discardedAdmissions: readonly { entryId: string; identity: SerializedAdmissionIdentity }[];
    },
  ) {
    this.#filePath = journalPath(options.directory, options.chatId, options.agentOwnershipEpoch);
    this.#entries = [...state.entries];
    this.#contentEpoch = state.contentEpoch;
    this.#nativeRetentionFloor = state.nativeRetentionFloor;
    this.#aliases = state.aliases;
    this.#handoffCleanupBlocked = state.handoffCleanupBlocked;
    for (const discarded of state.discardedAdmissions) {
      this.#discardedAdmissions.set(admissionKey(discarded.identity), discarded);
    }
  }

  static async open(options: ProjectionJournalOptions): Promise<AgentProjectionJournal> {
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    const filePath = journalPath(options.directory, options.chatId, options.agentOwnershipEpoch);
    let raw: Buffer | null = null;
    try {
      raw = await fs.readFile(filePath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    if (raw === null) {
      const entries = [...(options.bootstrapEntries ?? [])];
      if (entries.some((entry) => entry.lifetime !== 'durable')) {
        throw new TypeError('Journal bootstrap entries must be durable');
      }
      validateEntries(entries);
      const state = {
        chatId: options.chatId,
        agentOwnershipEpoch: options.agentOwnershipEpoch,
        contentEpoch: options.contentEpoch ?? newAgentTranscriptContentEpoch(),
        entries,
        nativeRetentionFloor: 0,
        aliases: {},
        handoffCleanupBlocked: false,
        discardedAdmissions: [],
      } as const;
      await replaceJournal(filePath, header(options), snapshotRecord(state));
      return new AgentProjectionJournal(options, state);
    }
    const parsed = await parseJournal(filePath, raw, options);
    return new AgentProjectionJournal(options, parsed);
  }

  static async exists(options: ProjectionJournalOptions): Promise<boolean> {
    try {
      await fs.stat(journalPath(options.directory, options.chatId, options.agentOwnershipEpoch));
      return true;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
  }

  get state(): ProjectionJournalState {
    return {
      chatId: this.options.chatId,
      agentOwnershipEpoch: this.options.agentOwnershipEpoch,
      contentEpoch: this.#contentEpoch,
      entries: this.#entries.map((entry) => ({ ...entry })),
      nativeRetentionFloor: this.#nativeRetentionFloor,
      aliases: this.#aliases,
      handoffCleanupBlocked: this.#handoffCleanupBlocked,
    };
  }

  get filePath(): string {
    return this.#filePath;
  }

  indexSource(ownerId: string): AgentTranscriptIndexSourceRefV4 {
    const revisions = computeProjectionRevisions(this.#entries);
    return {
      apiVersion: 2,
      ownerId,
      schemaVersion: 2,
      checkpoint: {
        chatId: this.options.chatId,
        agentOwnershipEpoch: this.options.agentOwnershipEpoch,
        contentEpoch: this.#contentEpoch,
        durableCount: revisions.durableCount,
        durableRevision: revisions.durableRevision,
      },
      value: {
        directory: this.options.directory,
      },
    };
  }

  resolveDiscardedAdmission(
    identity: AgentTranscriptAdmissionIdentity,
  ): { readonly entryId: string } | null {
    const found = this.#discardedAdmissions.get(admissionKey(identity));
    if (!found || stableJsonStringify(found.identity) !== stableJsonStringify(serializedAdmission(identity))) {
      return null;
    }
    return { entryId: found.entryId };
  }

  async persist(
    event: AgentStreamEvent,
    previousEntries: readonly AgentTranscriptEntry[],
    resultingEntries: readonly AgentTranscriptEntry[],
  ): Promise<void> {
    if (event.kind === 'commit') {
      await this.#persistCommit(event, resultingEntries);
      return;
    }
    if (event.kind !== 'reset') return;
    if (event.reason === 'input-not-sent') {
      const active = previousEntries.at(-1);
      if (!active || active.lifetime !== 'active' || !active.provenance?.clientRequestId) {
        throw new TypeError('input-not-sent journal record requires the discarded admission');
      }
      const identity = serializedAdmission(active.provenance as AgentTranscriptAdmissionIdentity);
      const record: JournalDiscardRecord = {
        kind: 'input-not-sent',
        contentEpoch: this.#contentEpoch,
        durableRevision: event.checkpoint.projection.durableRevision,
        admission: identity,
        entryId: active.id,
      };
      await appendRecord(this.#filePath, record);
      this.#discardedAdmissions.set(admissionKey(identity), { entryId: active.id, identity });
      return;
    }
    if (resultingEntries.some((entry) => entry.lifetime !== 'durable')) {
      throw new TypeError('Destructive journal reset must be fully durable');
    }
    const nextState = {
      chatId: this.options.chatId,
      agentOwnershipEpoch: this.options.agentOwnershipEpoch,
      contentEpoch: event.checkpoint.projection.contentEpoch,
      entries: [...resultingEntries],
      nativeRetentionFloor: 0,
      aliases: {},
      handoffCleanupBlocked: false,
      discardedAdmissions: [],
    } as const;
    await replaceJournal(this.#filePath, header(this.options), snapshotRecord(nextState));
    this.#entries = [...resultingEntries];
    this.#contentEpoch = event.checkpoint.projection.contentEpoch;
    this.#nativeRetentionFloor = 0;
    this.#aliases = {};
    this.#handoffCleanupBlocked = false;
    this.#discardedAdmissions.clear();
  }

  async updateNativeMetadata(options: {
    readonly nativeRetentionFloor: number;
    readonly aliases: JsonObject;
  }): Promise<void> {
    if (!Number.isSafeInteger(options.nativeRetentionFloor)
        || options.nativeRetentionFloor < this.#nativeRetentionFloor
        || options.nativeRetentionFloor > this.#entries.length) {
      throw new TypeError('Native retention floor must advance monotonically within the ledger');
    }
    await appendRecord(this.#filePath, { kind: 'metadata', ...options });
    this.#nativeRetentionFloor = options.nativeRetentionFloor;
    this.#aliases = options.aliases;
  }

  async markHandoffBoundaryViolation(operationId: string): Promise<void> {
    if (this.#handoffCleanupBlocked) return;
    await appendRecord(this.#filePath, { kind: 'handoff-boundary-violation', operationId });
    this.#handoffCleanupBlocked = true;
  }

  async compact(): Promise<void> {
    const state = {
      ...this.state,
      discardedAdmissions: [...this.#discardedAdmissions.values()],
    };
    await replaceJournal(this.#filePath, header(this.options), snapshotRecord(state));
  }

  async delete(): Promise<void> {
    await AgentProjectionJournal.delete(this.options);
  }

  static async delete(options: ProjectionJournalOptions): Promise<void> {
    try {
      await fs.rm(journalPath(options.directory, options.chatId, options.agentOwnershipEpoch));
      await syncDirectory(options.directory);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }

  async #persistCommit(
    event: Extract<AgentStreamEvent, { readonly kind: 'commit' }>,
    resultingEntries: readonly AgentTranscriptEntry[],
  ): Promise<void> {
    if (event.previous.projection.durableCount !== this.#entries.length) {
      throw new TypeError('Journal durable prefix does not match commit predecessor');
    }
    const priorRevision = computeProjectionRevisions(this.#entries).durableRevision;
    if (priorRevision !== event.previous.projection.durableRevision) {
      throw new TypeError('Journal durable revision does not match commit predecessor');
    }
    const suffix = resultingEntries.slice(this.#entries.length);
    if (suffix.some((entry) => entry.lifetime !== 'durable')) return;
    if (suffix.length === 0) return;
    await appendRecord(this.#filePath, {
      kind: 'append',
      previousDurableRevision: priorRevision,
      entries: suffix,
    });
    this.#entries.push(...suffix);
  }
}

async function parseJournal(
  filePath: string,
  raw: Buffer,
  expected: ProjectionJournalOptions,
): Promise<ProjectionJournalState & {
  readonly discardedAdmissions: readonly { entryId: string; identity: SerializedAdmissionIdentity }[];
}> {
  const lastNewline = raw.lastIndexOf(0x0a);
  const completeLength = lastNewline + 1;
  if (completeLength < raw.length) {
    const file = await fs.open(filePath, 'r+');
    try {
      await file.truncate(completeLength);
      await file.sync();
    } finally {
      await file.close().catch(() => {});
    }
    raw = raw.subarray(0, completeLength);
  }
  const lines = raw.toString('utf8').split('\n').filter((line) => line.trim());
  if (lines.length < 2) throw new ProjectionJournalCorruptError('Projection journal is incomplete');
  const records = lines.map((line, index) => parseRecord(line, index + 1));
  const first = records[0];
  if (first?.kind !== 'header' || first.schemaVersion !== JOURNAL_SCHEMA_VERSION
      || first.chatId !== expected.chatId
      || first.agentOwnershipEpoch !== expected.agentOwnershipEpoch) {
    throw new ProjectionJournalCorruptError('Projection journal header does not match its segment');
  }
  const snapshot = records[1];
  if (snapshot?.kind !== 'snapshot') {
    throw new ProjectionJournalCorruptError('Projection journal is missing its snapshot');
  }
  let entries = snapshot.entries.map(parseEntry);
  let contentEpoch = agentTranscriptContentEpoch(snapshot.contentEpoch);
  let nativeRetentionFloor = snapshot.nativeRetentionFloor;
  let aliases = snapshot.aliases;
  let handoffCleanupBlocked = snapshot.handoffCleanupBlocked === true;
  const discarded = new Map<string, { entryId: string; identity: SerializedAdmissionIdentity }>();
  for (const value of snapshot.discardedAdmissions) {
    const identity = parseAdmission(value);
    discarded.set(admissionKey(identity), { entryId: valueEntryId(value), identity });
  }
  for (const record of records.slice(2)) {
    if (record.kind === 'append') {
      const revision = computeProjectionRevisions(entries).durableRevision;
      if (record.previousDurableRevision !== revision) {
        throw new ProjectionJournalCorruptError('Projection append does not match its durable prefix');
      }
      entries = [...entries, ...record.entries.map(parseEntry)];
    } else if (record.kind === 'input-not-sent') {
      if (record.contentEpoch !== contentEpoch
          || record.durableRevision !== computeProjectionRevisions(entries).durableRevision) {
        throw new ProjectionJournalCorruptError('Input discard manifest does not match its durable root');
      }
      const identity = parseAdmission(record.admission);
      discarded.set(admissionKey(identity), { entryId: record.entryId, identity });
    } else if (record.kind === 'metadata') {
      if (!Number.isSafeInteger(record.nativeRetentionFloor)
          || record.nativeRetentionFloor < nativeRetentionFloor
          || record.nativeRetentionFloor > entries.length) {
        throw new ProjectionJournalCorruptError('Projection native retention floor regressed');
      }
      nativeRetentionFloor = record.nativeRetentionFloor;
      aliases = record.aliases;
    } else if (record.kind === 'handoff-boundary-violation') {
      if (!record.operationId) {
        throw new ProjectionJournalCorruptError('Projection handoff violation is missing its operation ID');
      }
      handoffCleanupBlocked = true;
    } else {
      throw new ProjectionJournalCorruptError('Projection journal contains an unexpected record');
    }
  }
  validateEntries(entries);
  return {
    chatId: expected.chatId,
    agentOwnershipEpoch: expected.agentOwnershipEpoch,
    contentEpoch,
    entries,
    nativeRetentionFloor,
    aliases,
    handoffCleanupBlocked,
    discardedAdmissions: [...discarded.values()],
  };
}

function parseRecord(line: string, lineNumber: number): JournalRecord {
  try {
    const record = JSON.parse(line) as JournalRecord;
    if (!record || typeof record !== 'object' || typeof record.kind !== 'string') throw new Error();
    return record;
  } catch {
    throw new ProjectionJournalCorruptError(`Projection journal has malformed record at line ${lineNumber}`);
  }
}

function parseEntry(value: AgentTranscriptEntry): AgentTranscriptEntry {
  if (!value || typeof value !== 'object') throw new ProjectionJournalCorruptError('Invalid transcript entry');
  const message = parseChatMessage(value.message as unknown as Record<string, unknown>);
  if (!message || (value.lifetime !== 'durable' && value.lifetime !== 'active')) {
    throw new ProjectionJournalCorruptError('Invalid transcript entry payload');
  }
  const entry: AgentTranscriptEntry = {
    id: agentTranscriptEntryId(value.id),
    lifetime: value.lifetime,
    source: value.source,
    provenance: value.provenance,
    message,
  };
  if (entry.source) sourceIdentityKey(entry.source);
  return entry;
}

function parseAdmission(value: SerializedAdmissionIdentity): SerializedAdmissionIdentity {
  if (!value || typeof value !== 'object' || !value.agentOwnershipEpoch
      || !value.clientRequestId || !value.turnId || !value.turnOwner) {
    throw new ProjectionJournalCorruptError('Invalid persisted admission identity');
  }
  return value;
}

function valueEntryId(value: unknown): string {
  const entryId = (value as { readonly entryId?: unknown }).entryId;
  if (typeof entryId !== 'string' || !entryId) {
    throw new ProjectionJournalCorruptError('Discarded admission is missing its entry ID');
  }
  return entryId;
}

function header(identity: AgentSegmentIdentity): JournalHeader {
  return {
    kind: 'header',
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    chatId: identity.chatId,
    agentOwnershipEpoch: identity.agentOwnershipEpoch,
  };
}

function snapshotRecord(state: {
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly discardedAdmissions: readonly ({ entryId: string; identity: SerializedAdmissionIdentity } | SerializedAdmissionIdentity)[];
  readonly nativeRetentionFloor: number;
  readonly aliases: JsonObject;
  readonly handoffCleanupBlocked: boolean;
}): JournalSnapshotRecord {
  return {
    kind: 'snapshot',
    contentEpoch: state.contentEpoch,
    entries: state.entries,
    discardedAdmissions: state.discardedAdmissions.map((value) => (
      'identity' in value ? { ...value.identity, entryId: value.entryId } : value
    )) as readonly PersistedDiscardedAdmission[],
    nativeRetentionFloor: state.nativeRetentionFloor,
    aliases: state.aliases,
    handoffCleanupBlocked: state.handoffCleanupBlocked,
  };
}

function serializedAdmission(identity: AgentTranscriptAdmissionIdentity): SerializedAdmissionIdentity {
  return {
    agentOwnershipEpoch: identity.agentOwnershipEpoch,
    clientRequestId: identity.clientRequestId,
    clientMessageId: identity.clientMessageId,
    turnId: identity.turnId,
    commandType: identity.commandType,
    turnOwner: identity.turnOwner,
  };
}

function admissionKey(identity: Pick<SerializedAdmissionIdentity, 'agentOwnershipEpoch' | 'clientRequestId'>): string {
  return `${identity.agentOwnershipEpoch}:${identity.clientRequestId}`;
}

function journalPath(directory: string, chatId: string, ownershipEpoch: string): string {
  const key = createHash('sha256').update(`${chatId}\0${ownershipEpoch}`).digest('hex');
  return path.join(directory, `${key}.projection.jsonl`);
}

async function appendRecord(filePath: string, record: Exclude<JournalRecord, JournalHeader | JournalSnapshotRecord>): Promise<void> {
  const file = await fs.open(filePath, 'a', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close().catch(() => {});
  }
}

async function replaceJournal(
  filePath: string,
  journalHeader: JournalHeader,
  snapshot: JournalSnapshotRecord,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journalHeader)}\n${JSON.stringify(snapshot)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close().catch(() => {});
  }
  try {
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

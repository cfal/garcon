import type {
  AgentControlEvent,
  AgentControlRow,
  AgentStreamEvent,
  AgentTranscriptCommitEvent,
  AgentTranscriptEntry,
  AgentTranscriptResetEvent,
} from '@garcon/server-agent-interface';
import { stableJsonStringify } from '@garcon/common/json';
import { sameCheckpoint, sameProjectionState, sameSegment, sourceIdentityKey } from './identity.js';
import { computeAgentStreamEventDigest } from './revision.js';
import {
  controlIdentity,
  createProjectionState,
  type AgentProjectionMaterialization,
} from './state.js';

export interface ApplyProjectionEventOptions {
  readonly resetEntries?: readonly AgentTranscriptEntry[];
}

export function applyProjectionEvent(
  current: AgentProjectionMaterialization,
  event: AgentStreamEvent,
  options: ApplyProjectionEventOptions = {},
): AgentProjectionMaterialization {
  validateEnvelope(current, event);
  switch (event.kind) {
    case 'commit':
      return applyCommit(current, event);
    case 'reset':
      return applyReset(current, event, options.resetEntries);
    case 'control':
      return applyControl(current, event);
    case 'session':
      if (!sameProjectionState(event.previous.projection, event.checkpoint.projection)) {
        throw new TypeError(`${event.kind} event cannot change transcript projection state`);
      }
      return { ...current, checkpoint: event.checkpoint };
    case 'terminal': {
      if (!sameProjectionState(event.previous.projection, event.checkpoint.projection)) {
        throw new TypeError('terminal event cannot change transcript projection state');
      }
      const controls = new Map(current.controls);
      const retired = new Set(current.retiredControlIncarnations);
      for (const [id, row] of controls) {
        if (!sameTurnOwner(row.operation.turnOwner, event.operation.turnOwner)) continue;
        controls.delete(id);
        retired.add(controlIdentity(row.id, row.incarnation));
      }
      return {
        ...current,
        checkpoint: event.checkpoint,
        controls,
        retiredControlIncarnations: retired,
      };
    }
  }
}

function validateEnvelope(
  current: AgentProjectionMaterialization,
  event: AgentStreamEvent,
): void {
  if (!sameSegment(current, event) || !sameSegment(event.previous, event.checkpoint)) {
    throw new TypeError('Projection event ownership does not match the materialization');
  }
  if (!sameCheckpoint(current.checkpoint, event.previous)) {
    throw new TypeError('Projection event predecessor does not match current checkpoint');
  }
  if (event.digest !== computeAgentStreamEventDigest(event)) {
    throw new TypeError('Projection event digest does not match its payload');
  }
}

function applyCommit(
  current: AgentProjectionMaterialization,
  event: AgentTranscriptCommitEvent,
): AgentProjectionMaterialization {
  if (event.checkpoint.projection.epoch !== current.checkpoint.projection.epoch
      || event.checkpoint.projection.contentEpoch !== current.checkpoint.projection.contentEpoch) {
    throw new TypeError('Transcript commit cannot change projection epochs');
  }
  const entries = current.entries.map(cloneEntry);
  const promotedIds = new Set<string>();
  for (const promotion of event.promoted) {
    if (promotedIds.has(promotion.entryId)) throw new TypeError('Promotion IDs must be unique');
    promotedIds.add(promotion.entryId);
    const index = entries.findIndex((entry) => entry.id === promotion.entryId);
    if (index < 0 || entries[index]!.lifetime !== 'active') {
      throw new TypeError('Promotion must bind the active suffix exactly once');
    }
    entries[index] = {
      ...entries[index]!,
      lifetime: 'durable',
      source: promotion.source,
    };
  }
  for (const entry of event.appended) entries.push(cloneEntry(entry));
  const projection = createProjectionState(
    current.checkpoint.projection.epoch,
    current.checkpoint.projection.contentEpoch,
    entries,
  );
  if (!sameProjectionState(projection, event.checkpoint.projection)) {
    throw new TypeError('Transcript commit checkpoint does not match resulting entries');
  }
  return { ...current, checkpoint: event.checkpoint, entries };
}

function applyReset(
  current: AgentProjectionMaterialization,
  event: AgentTranscriptResetEvent,
  resetEntries: readonly AgentTranscriptEntry[] | undefined,
): AgentProjectionMaterialization {
  if (event.checkpoint.projection.epoch === current.checkpoint.projection.epoch) {
    throw new TypeError('Transcript reset must create a new stream epoch');
  }
  if (!resetEntries) throw new TypeError('Transcript reset requires a staged target');
  const entries = resetEntries.map(cloneEntry);
  const projection = createProjectionState(
    event.checkpoint.projection.epoch,
    event.checkpoint.projection.contentEpoch,
    entries,
  );
  if (!sameProjectionState(projection, event.checkpoint.projection)) {
    throw new TypeError('Transcript reset checkpoint does not match its staged target');
  }
  validateReset(current, event, entries);
  return {
    ...current,
    checkpoint: event.checkpoint,
    entries,
    controls: event.reason === 'input-not-sent' ? current.controls : new Map(),
    retiredControlIncarnations: event.reason === 'input-not-sent'
      ? current.retiredControlIncarnations
      : new Set(current.retiredControlIncarnations),
  };
}

function validateReset(
  current: AgentProjectionMaterialization,
  event: AgentTranscriptResetEvent,
  entries: readonly AgentTranscriptEntry[],
): void {
  if (event.reason !== 'input-not-sent') {
    if (event.checkpoint.projection.contentEpoch === current.checkpoint.projection.contentEpoch) {
      throw new TypeError('Destructive reset must rotate ledger content epoch');
    }
    if (event.checkpoint.projection.durableCount !== event.checkpoint.projection.total) {
      throw new TypeError('Destructive reset target must be fully durable');
    }
    return;
  }
  const previous = current.checkpoint.projection;
  const next = event.checkpoint.projection;
  if (previous.total !== previous.durableCount + 1
      || next.total !== previous.durableCount
      || next.durableCount !== previous.durableCount
      || next.durableRevision !== previous.durableRevision
      || next.contentEpoch !== previous.contentEpoch) {
    throw new TypeError('input-not-sent reset must preserve the complete durable prefix');
  }
  const active = current.entries.at(-1);
  if (!active || active.lifetime !== 'active') {
    throw new TypeError('input-not-sent reset requires one trailing active entry');
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (!sameStoredEntry(entries[index]!, current.entries[index]!)) {
      throw new TypeError('input-not-sent reset changed a durable envelope');
    }
  }
}

function applyControl(
  current: AgentProjectionMaterialization,
  event: AgentControlEvent,
): AgentProjectionMaterialization {
  if (!sameProjectionState(event.previous.projection, event.checkpoint.projection)) {
    throw new TypeError('Control event cannot change transcript projection state');
  }
  const controls = new Map(current.controls);
  const retired = new Set(current.retiredControlIncarnations);
  const mutation = event.mutation;
  if (mutation.kind === 'clear') {
    for (const [id, row] of controls) {
      if (!sameTurnOwner(row.operation.turnOwner, event.operation.turnOwner)) continue;
      retired.add(controlIdentity(row.id, row.incarnation));
      controls.delete(id);
    }
  } else if (mutation.kind === 'remove') {
    const row = controls.get(mutation.id);
    if (!row || row.incarnation !== mutation.incarnation) {
      throw new TypeError('Control removal must name the current incarnation');
    }
    controls.delete(mutation.id);
    retired.add(controlIdentity(mutation.id, mutation.incarnation));
  } else {
    validateControlRow(event, mutation.row);
    const key = controlIdentity(mutation.row.id, mutation.row.incarnation);
    if (retired.has(key)) throw new TypeError('A retired control incarnation cannot be reused');
    const existing = controls.get(mutation.row.id);
    if (existing && existing.incarnation !== mutation.row.incarnation) {
      retired.add(controlIdentity(existing.id, existing.incarnation));
    }
    for (const control of controls.values()) {
      if (!sameTurnOwner(control.operation.turnOwner, event.operation.turnOwner)) {
        throw new TypeError('One projection control fold cannot contain multiple turn owners');
      }
    }
    controls.set(mutation.row.id, mutation.row);
  }
  return {
    ...current,
    checkpoint: event.checkpoint,
    controls,
    retiredControlIncarnations: retired,
  };
}

function validateControlRow(event: AgentControlEvent, row: AgentControlRow): void {
  if (!row.id || !row.incarnation || !Number.isSafeInteger(row.displayOrder)
      || row.displayOrder < 0) {
    throw new TypeError('Control row identity and display order are required');
  }
  if (stableJsonStringify(row.operation) !== stableJsonStringify(event.operation)) {
    throw new TypeError('Control row operation does not match its event');
  }
  if (row.message.type !== 'permission-request'
      || row.message.permissionRequestId !== row.id) {
    throw new TypeError('Control row must contain its matching permission request');
  }
}

function sameTurnOwner(
  left: AgentControlRow['operation']['turnOwner'],
  right: AgentControlRow['operation']['turnOwner'],
): boolean {
  return left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.commandType === right.commandType
    && left.clientRequestId === right.clientRequestId
    && left.turnId === right.turnId;
}

function cloneEntry(entry: AgentTranscriptEntry): AgentTranscriptEntry {
  return { ...entry };
}

function sameStoredEntry(left: AgentTranscriptEntry, right: AgentTranscriptEntry): boolean {
  return left.id === right.id
    && left.lifetime === right.lifetime
    && stableJsonStringify(left.source) === stableJsonStringify(right.source)
    && stableJsonStringify(left.provenance) === stableJsonStringify(right.provenance)
    && stableJsonStringify(left.message) === stableJsonStringify(right.message);
}

import type { PendingUserInputAttachment } from '../../common/pending-user-input.js';
import type { CommandLedger, CommandLedgerRecord } from '../commands/command-ledger.js';
import type { PendingUserInputService } from './pending-user-input-service.js';
import type { PendingUserInputImageEvidence } from './pending-user-input-store.js';

interface PendingUserInputRecoveryDeps {
  ledger: Pick<
    CommandLedger,
    'listRestartInterruptedUserInputs' | 'settleRestartInterruptedUserInput'
  >;
  pendingInputs: Pick<PendingUserInputService, 'restoreInterrupted'>;
  chatExists(chatId: string): boolean;
}

export interface PendingUserInputRecoveryResult {
  restored: number;
  discardedMissingChat: number;
}

function attachmentPlaceholder(value: unknown): PendingUserInputAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  return {
    name: raw.name,
    ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
  };
}

function attachmentEvidence(value: unknown): PendingUserInputImageEvidence | null {
  const attachment = attachmentPlaceholder(value);
  if (!attachment || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.dataSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.dataSha256)
    || typeof raw.dataLength !== 'number'
    || !Number.isSafeInteger(raw.dataLength)
    || raw.dataLength < 0
  ) {
    return null;
  }
  return {
    ...attachment,
    dataSha256: raw.dataSha256,
    dataLength: raw.dataLength,
  };
}

function recoveryAttachments(record: CommandLedgerRecord): {
  attachments?: PendingUserInputAttachment[];
  imageEvidence?: PendingUserInputImageEvidence[];
} {
  if (!Array.isArray(record.payload.images) || record.payload.images.length === 0) return {};
  const attachments = record.payload.images.flatMap((value) => {
    const attachment = attachmentPlaceholder(value);
    return attachment ? [attachment] : [];
  });
  const evidence = record.payload.images.flatMap((value) => {
    const entry = attachmentEvidence(value);
    return entry ? [entry] : [];
  });
  return {
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(evidence.length === record.payload.images.length ? { imageEvidence: evidence } : {}),
  };
}

export async function restoreRestartInterruptedPendingInputs(
  deps: PendingUserInputRecoveryDeps,
): Promise<PendingUserInputRecoveryResult> {
  const records = await deps.ledger.listRestartInterruptedUserInputs();
  let restored = 0;
  let discardedMissingChat = 0;

  for (const record of records) {
    if (!deps.chatExists(record.chatId)) {
      await deps.ledger.settleRestartInterruptedUserInput(record.chatId, record.clientRequestId);
      discardedMissingChat += 1;
      continue;
    }
    deps.pendingInputs.restoreInterrupted({
      chatId: record.chatId,
      clientRequestId: record.clientRequestId,
      content: typeof record.payload.command === 'string' ? record.payload.command : '',
      createdAt: record.acceptedAt,
      ...(typeof record.payload.clientMessageId === 'string'
        ? { clientMessageId: record.payload.clientMessageId }
        : {}),
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...recoveryAttachments(record),
    });
    restored += 1;
  }

  return { restored, discardedMissingChat };
}

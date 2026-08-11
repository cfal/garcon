import type { AgentSteerRequestV4, AgentSteerResult } from '@garcon/server-agent-interface';
import {
  CodexAppServerDeliveryError,
  CodexAppServerRpcError,
  type CodexAppServerClient,
} from './client.ts';
import { buildUserInput } from './request-builders.ts';

interface SteerableCodexSession {
  threadId: string;
  client: CodexAppServerClient;
  activeDeliveryReservations: number;
}

export async function steerCodexSession(
  session: SteerableCodexSession,
  expectedTurnId: string,
  request: AgentSteerRequestV4,
  flushPendingFinish: () => void,
): Promise<AgentSteerResult> {
  session.activeDeliveryReservations += 1;
  try {
    const response = await session.client.steerTurn({
      threadId: session.threadId,
      expectedTurnId,
      input: buildUserInput(request.input, []),
      clientUserMessageId: request.clientMessageId,
    }, {
      prepareDelivery: request.prepareDelivery,
    });
    if (response.turnId !== expectedTurnId) {
      return failedSteer('unknown', 'Codex acknowledged steering for an unexpected turn');
    }
    return { kind: 'accepted' };
  } catch (error) {
    if (error instanceof CodexAppServerRpcError) return classifyCodexSteerRejection(error);
    if (error instanceof CodexAppServerDeliveryError) {
      return failedSteer(error.outcome, error.safeMessage);
    }
    throw error;
  } finally {
    session.activeDeliveryReservations -= 1;
    flushPendingFinish();
  }
}

export function rejectedCodexSteer(
  reason: Extract<AgentSteerResult, { kind: 'rejected' }>['reason'],
  message: string,
): AgentSteerResult {
  return { kind: 'rejected', reason, message };
}

function failedSteer(
  outcome: Extract<AgentSteerResult, { kind: 'failed' }>['outcome'],
  message: string,
): AgentSteerResult {
  return { kind: 'failed', outcome, message };
}

function classifyCodexSteerRejection(error: CodexAppServerRpcError): AgentSteerResult {
  if (actualTurnIdFromSteerMismatch(error)) {
    return rejectedCodexSteer('turn-changed', 'The active Codex turn changed');
  }
  if (isActiveTurnNotSteerableError(error)) {
    return rejectedCodexSteer('turn-not-steerable', 'The active Codex turn cannot be steered');
  }
  if (isNoActiveTurnError(error)) {
    return rejectedCodexSteer('no-active-turn', 'No active Codex turn');
  }
  const data = error.data && typeof error.data === 'object'
    ? error.data as Record<string, unknown>
    : null;
  if (
    data?.input_error_code === 'input_too_large'
    || /empty input|input.*(?:too large|limit|exceeds.*maximum length)|invalid input/i.test(error.message)
  ) {
    return rejectedCodexSteer('invalid-input', 'Codex rejected the steering input');
  }
  return rejectedCodexSteer('provider-rejected', 'Codex rejected the steering input');
}

export function isNoActiveTurnError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '');
  return /no active turn|expected turn.*(?:not active|mismatch|active turn)|active turn.*not found/i.test(message);
}

export function isActiveTurnNotSteerableError(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError) {
    const data = error.data && typeof error.data === 'object'
      ? error.data as Record<string, unknown>
      : null;
    const codexErrorInfo = data?.codexErrorInfo;
    if (
      codexErrorInfo
      && typeof codexErrorInfo === 'object'
      && 'activeTurnNotSteerable' in codexErrorInfo
    ) {
      return true;
    }
  }
  const message = String((error as Error)?.message || error || '');
  return /cannot steer (?:a )?(?:review|compact) turn/i.test(message);
}

export function actualTurnIdFromSteerMismatch(error: unknown): string | null {
  const message = String((error as Error)?.message || error || '');
  const match = /^expected active turn id `[^`]+` but found `([^`]+)`$/.exec(message);
  return match?.[1] ?? null;
}

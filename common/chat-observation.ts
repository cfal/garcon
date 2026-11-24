import { isRecord } from './json.js';

export interface ChatObservation {
  readonly kind: 'native-child';
  readonly captureStatus: 'attached' | 'detached';
  readonly isWorking: boolean;
}

export type NativeChildStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export function isNativeChildStatus(value: unknown): value is NativeChildStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'interrupted';
}

export function parseChatObservation(value: unknown): ChatObservation | null {
  if (value === null) return null;
  if (!isRecord(value) || value.kind !== 'native-child'
    || (value.captureStatus !== 'attached' && value.captureStatus !== 'detached')
    || typeof value.isWorking !== 'boolean'
    || (value.captureStatus === 'detached' && value.isWorking)) {
    throw new TypeError('Invalid chat observation');
  }
  return { kind: 'native-child', captureStatus: value.captureStatus, isWorking: value.isWorking };
}

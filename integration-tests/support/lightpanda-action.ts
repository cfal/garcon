import { ProtocolError } from 'puppeteer-core';

export async function performLightpandaAction(
  action: () => Promise<unknown>,
  confirm: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    // A DOM transition can collect the CDP reply after the action has already taken effect.
    if (!(error instanceof ProtocolError) || error.originalMessage !== 'Promise was collected') throw error;
  }
  await confirm();
}

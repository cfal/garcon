import { getPiAvailableModels } from '../../../../server-agents/pi/src/agents/pi/pi-models.ts';

try {
  await getPiAvailableModels(Bun.argv[2]!, AbortSignal.timeout(5000));
  throw new Error('Expected model discovery to fail');
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('Pi model discovery failed (exit ')) {
    throw error;
  }
  process.stdout.write(error.message);
}

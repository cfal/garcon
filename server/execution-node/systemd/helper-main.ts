import { readTextStreamWithLimit } from '../../lib/bounded-text-stream.js';
import {
  parseSystemdHelperRequest, SYSTEMD_HELPER_FLAG, SYSTEMD_HELPER_MAX_BYTES,
  SystemdContainmentError, type SystemdHelperReply,
} from './contracts.js';

/** Enters before controller construction and never loads provider integrations. */
export async function runSystemdHelperMain(): Promise<void> {
  let reply: SystemdHelperReply;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== SYSTEMD_HELPER_FLAG) throw invalid();
    const { armSystemdHelperDeadline } = await import('./helper-deadline.js');
    await armSystemdHelperDeadline();
    const input = await readTextStreamWithLimit(Bun.stdin.stream(), SYSTEMD_HELPER_MAX_BYTES, invalid);
    const request = parseSystemdHelperRequest(JSON.parse(input));
    if (!request) throw invalid();
    const { NativeSystemdBus } = await import('./bus.js');
    const { NativeCgroupReader } = await import('./cgroup.js');
    const { runSystemdOwnershipRequest } = await import('./ownership.js');
    reply = await runSystemdOwnershipRequest(request, new NativeSystemdBus(), new NativeCgroupReader());
  } catch (error) {
    reply = { kind: 'failed', code: error instanceof SystemdContainmentError ? error.code : 'NODE_CONTAINMENT_UNAVAILABLE' };
  }
  await Bun.write(Bun.stdout, `${JSON.stringify(reply)}\n`);
}

function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH'); }

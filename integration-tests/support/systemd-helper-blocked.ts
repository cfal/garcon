import { dlopen, FFIType } from 'bun:ffi';
import { armSystemdHelperDeadline } from '../../server/execution-node/systemd/helper-deadline.js';

await armSystemdHelperDeadline(1_000);
const native = dlopen('libc.so.6', { pause: { args: [], returns: FFIType.i32 } });
console.log('armed');
native.symbols.pause();
throw new Error('Synthetic native pause returned');

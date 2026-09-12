import { SYSTEMD_HELPER_TIMEOUT_MS, SystemdContainmentError } from './contracts.js';

/** Keeps the helper deadline active during blocked native calls and after parent death. */
export async function armSystemdHelperDeadline(timeoutMs = SYSTEMD_HELPER_TIMEOUT_MS): Promise<void> {
  const seconds = timeoutMs / 1_000;
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
    || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 0xffff_ffff) throw unavailable();
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const library = dlopen('libc.so.6', {
    signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64 },
    sigemptyset: { args: [FFIType.ptr], returns: FFIType.i32 },
    sigaddset: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    pthread_sigmask: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    alarm: { args: [FFIType.u32], returns: FFIType.u32 },
  });
  try {
    const native = library.symbols;
    const SIGALRM = 14;
    const SIG_UNBLOCK = 1;
    // glibc LP64 sigset_t occupies 128 aligned bytes on both supported architectures.
    const mask = new BigUint64Array(16);
    if (BigInt(native.signal(SIGALRM, null)) === -1n || native.sigemptyset(ptr(mask)) !== 0
      || native.sigaddset(ptr(mask), SIGALRM) !== 0 || native.pthread_sigmask(SIG_UNBLOCK, ptr(mask), null) !== 0) throw unavailable();
    native.alarm(seconds);
  } finally {
    // The kernel owns the alarm; closing the FFI bindings never disarms it.
    library.close();
  }
}

function unavailable(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_UNAVAILABLE'); }

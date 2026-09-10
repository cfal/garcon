import { CString, dlopen, FFIType, ptr, type Pointer } from 'bun:ffi';
import type { SystemdUnitBus, SystemdUnitSnapshot } from './contracts.js';

const DESTINATION = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER = `${DESTINATION}.Manager`;
const UNIT = `${DESTINATION}.Unit`;
const SERVICE = `${DESTINATION}.Service`;
const CALL_TIMEOUT_USEC = 1_000_000;

const symbols = {
  sd_bus_open_user: { args: [FFIType.ptr], returns: FFIType.i32 },
  sd_bus_close_unref: { args: [FFIType.ptr], returns: FFIType.ptr },
  sd_bus_message_new_method_call: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32,
  },
  sd_bus_message_append_basic: { args: [FFIType.ptr, FFIType.char, FFIType.ptr], returns: FFIType.i32 },
  sd_bus_call: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sd_bus_message_unref: { args: [FFIType.ptr], returns: FFIType.ptr },
  sd_bus_message_read_basic: { args: [FFIType.ptr, FFIType.char, FFIType.ptr], returns: FFIType.i32 },
  sd_bus_message_enter_container: { args: [FFIType.ptr, FFIType.char, FFIType.ptr], returns: FFIType.i32 },
  sd_bus_message_exit_container: { args: [FFIType.ptr], returns: FFIType.i32 },
  sd_bus_message_at_end: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

export class SystemdBusError extends Error {
  constructor(readonly operation: string, readonly errno: number) {
    super(`systemd ${operation} failed (${errno})`);
    this.name = 'SystemdBusError';
  }
}

/** Runs only in a dedicated helper process; an outer process deadline bounds native bootstrap and calls. */
export class NativeSystemdBus implements SystemdUnitBus {
  readonly #library: ReturnType<typeof openLibrary>;
  #bus: Pointer | null = null;
  #closed = false;

  constructor() {
    this.#library = openLibrary();
    const output = new BigUint64Array(1);
    try {
      checked('open user bus', this.#library.symbols.sd_bus_open_user(ptr(output)));
      this.#bus = pointerValue(output);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  refUnit(name: string): boolean {
    try {
      this.#managerCall('RefUnit', [name]);
      return true;
    } catch (error) {
      if (error instanceof SystemdBusError && error.errno === -2) return false;
      throw error;
    }
  }
  unrefUnit(name: string): void { this.#managerCall('UnrefUnit', [name]); }

  stopUnit(name: string): void {
    this.#managerCall('StopUnit', [name, 'fail'], (reply) => {
      const job = this.#string(reply, 'o');
      if (!/^\/org\/freedesktop\/systemd1\/job\/[1-9][0-9]*$/.test(job)) throw malformed();
    });
  }

  managerControlGroup(): string {
    return this.#property(MANAGER_PATH, MANAGER, 'ControlGroup', 's', (reply) => this.#string(reply));
  }

  exists(name: string): boolean { return this.#unitPath(name) !== null; }

  #unitPath(name: string): string | null {
    let path: string;
    try {
      path = this.#managerCall('GetUnit', [name], (reply) => this.#string(reply, 'o'));
    } catch (error) {
      if (error instanceof SystemdBusError && error.errno === -2) return null;
      throw error;
    }
    if (!/^\/org\/freedesktop\/systemd1\/unit\/[a-zA-Z0-9_]+$/.test(path)) throw malformed();
    return path;
  }

  snapshot(name: string): SystemdUnitSnapshot | null {
    const path = this.#unitPath(name);
    if (path === null) return null;
    const string = (iface: string, field: string) => this.#property(path, iface, field, 's', (reply) => this.#string(reply));
    const uint = (iface: string, field: string) => this.#property(path, iface, field, 'u', (reply) => this.#uint(reply));
    const boolean = (iface: string, field: string) => this.#property(path, iface, field, 'b', (reply) => {
      const value = new Int32Array(1);
      this.#read(reply, 'b', value);
      if (value[0] !== 0 && value[0] !== 1) throw malformed();
      return value[0] === 1;
    });
    return {
      id: string(UNIT, 'Id'),
      description: string(UNIT, 'Description'),
      invocationId: this.#property(path, UNIT, 'InvocationID', 'ay', (reply) => {
        this.#enter(reply, 'a', 'y');
        const bytes = new Uint8Array(16);
        for (let index = 0; index < bytes.length; index += 1) this.#read(reply, 'y', bytes.subarray(index, index + 1));
        this.#exit(reply);
        return Buffer.from(bytes).toString('hex');
      }),
      controlGroup: string(SERVICE, 'ControlGroup'),
      loadState: string(UNIT, 'LoadState'),
      activeState: string(UNIT, 'ActiveState'),
      subState: string(UNIT, 'SubState'),
      mainPid: uint(SERVICE, 'MainPID'),
      jobId: this.#property(path, UNIT, 'Job', '(uo)', (reply) => {
        this.#enter(reply, 'r', 'uo');
        const id = this.#uint(reply);
        this.#string(reply, 'o');
        this.#exit(reply);
        return id;
      }),
      serviceType: string(SERVICE, 'Type'),
      killMode: string(SERVICE, 'KillMode'),
      sendSigkill: boolean(SERVICE, 'SendSIGKILL'),
      timeoutStopUsec: this.#property(path, SERVICE, 'TimeoutStopUSec', 't', (reply) => {
        const value = new BigUint64Array(1);
        this.#read(reply, 't', value);
        return value[0]!;
      }),
      restart: string(SERVICE, 'Restart'),
      restarts: uint(SERVICE, 'NRestarts'),
      transient: boolean(UNIT, 'Transient'),
      collectMode: string(UNIT, 'CollectMode'),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#bus) this.#library.symbols.sd_bus_close_unref(this.#bus);
    this.#bus = null;
    this.#library.close();
  }

  #managerCall<T = void>(method: string, args: readonly string[], read?: (reply: Pointer) => T): T {
    return this.#call(MANAGER_PATH, MANAGER, method, args, read ?? (() => undefined as T));
  }

  #property<T>(path: string, iface: string, name: string, type: string, read: (reply: Pointer) => T): T {
    return this.#call(path, 'org.freedesktop.DBus.Properties', 'Get', [iface, name], (reply) => {
      this.#enter(reply, 'v', type);
      const value = read(reply);
      this.#exit(reply);
      return value;
    });
  }

  #call<T>(path: string, iface: string, method: string, args: readonly string[], read: (reply: Pointer) => T): T {
    if (this.#closed || !this.#bus) throw new Error('systemd bus is closed');
    const requestCell = new BigUint64Array(1);
    const replyCell = new BigUint64Array(1);
    const strings = [DESTINATION, path, iface, method, ...args].map(cstring);
    const native = this.#library.symbols;
    let request: Pointer | null = null;
    let reply: Pointer | null = null;
    try {
      checked(method, native.sd_bus_message_new_method_call(
        this.#bus, ptr(requestCell), ptr(strings[0]!), ptr(strings[1]!), ptr(strings[2]!), ptr(strings[3]!),
      ));
      request = pointerValue(requestCell);
      for (const value of strings.slice(4)) {
        // String append takes char*, whereas string read writes through char**.
        checked(method, native.sd_bus_message_append_basic(request, code('s'), ptr(value)));
      }
      checked(method, native.sd_bus_call(this.#bus, request, CALL_TIMEOUT_USEC, null, ptr(replyCell)));
      reply = pointerValue(replyCell);
      const value = read(reply);
      if (native.sd_bus_message_at_end(reply, 1) !== 1) throw malformed();
      return value;
    } finally {
      if (reply) native.sd_bus_message_unref(reply);
      if (request) native.sd_bus_message_unref(request);
    }
  }

  #string(reply: Pointer, type = 's'): string {
    const output = new BigUint64Array(1);
    this.#read(reply, type, output);
    const value = new CString(pointerValue(output)).toString();
    if (value.length > 4_096) throw malformed();
    return value;
  }

  #uint(reply: Pointer): number {
    const output = new Uint32Array(1);
    this.#read(reply, 'u', output);
    return output[0]!;
  }

  #read(reply: Pointer, type: string, output: Uint8Array | Uint32Array | Int32Array | BigUint64Array): void {
    if (this.#library.symbols.sd_bus_message_read_basic(reply, code(type), ptr(output)) !== 1) throw malformed();
  }

  #enter(reply: Pointer, type: string, contents: string): void {
    const signature = cstring(contents);
    if (this.#library.symbols.sd_bus_message_enter_container(reply, code(type), ptr(signature)) !== 1) throw malformed();
  }

  #exit(reply: Pointer): void {
    const native = this.#library.symbols;
    if (native.sd_bus_message_at_end(reply, 0) !== 1) throw malformed();
    if (native.sd_bus_message_exit_container(reply) !== 1) throw malformed();
  }
}

function openLibrary() {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('systemd containment requires 64-bit Linux');
  }
  return dlopen('libsystemd.so.0', symbols);
}

function pointerValue(cell: BigUint64Array): Pointer {
  const value = Number(cell[0]);
  if (!Number.isSafeInteger(value) || value <= 0) throw malformed();
  return value as Pointer;
}

function cstring(value: string): Buffer {
  if (value.includes('\0') || value.length > 4_096) throw new TypeError('Invalid systemd argument');
  return Buffer.from(`${value}\0`);
}

function code(value: string): number { return value.charCodeAt(0); }
function malformed(): Error { return new Error('Malformed systemd reply'); }
function checked(operation: string, result: number): void {
  if (result < 0) throw new SystemdBusError(operation, result);
}

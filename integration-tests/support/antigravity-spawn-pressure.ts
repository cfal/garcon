import { existsSync } from 'node:fs';

// Reproduces process pressure for the fixture's model probe without limiting the entire worker.
Bun.spawn = new Proxy(Bun.spawn, {
  apply(spawn, receiver, args) {
    const [command] = args;
    if (Array.isArray(command) && command[0] === process.env.GARCON_ANTIGRAVITY_BINARY
      && command[1] === 'models' && existsSync(`${command[0]}.busy`)) {
      throw Object.assign(new Error('Resource temporarily unavailable'), { syscall: 'posix_spawn', code: 'EAGAIN' });
    }
    return Reflect.apply(spawn, receiver, args);
  },
});

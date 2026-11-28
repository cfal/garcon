import { expect, test } from 'bun:test';
import { executorCommand } from '../../../../integration-tests/support/execution-backend.js';
import { controllerLaunch } from '../../../../integration-tests/support/garcon-process.js';

const root = '/checkout';

function withEnvironment(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const assign = (values: typeof overrides) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  assign(overrides);
  try {
    run();
  } finally {
    assign(previous);
  }
}

test('controller selection preserves original and front-door and forces native for Rust', () => {
  withEnvironment({
    GARCON_TEST_CONTROLLER: undefined,
    GARCON_TEST_RUST_CONTROLLER_BINARY: undefined,
    GARCON_TEST_FRONT_DOOR_BINARY: '/front-door',
    GARCON_RS_CONTROLLER: 'original',
    GARCON_RS_SHADOW_LOG: '/shadow',
  }, () => {
    expect(controllerLaunch(root)).toEqual({
      controller: 'original',
      command: [process.execPath, 'server/main.ts'],
      environment: {},
    });
  });
  withEnvironment({
    GARCON_TEST_CONTROLLER: 'front-door',
    GARCON_TEST_FRONT_DOOR_BINARY: '/front-door',
    GARCON_RS_CONTROLLER: 'original',
    GARCON_RS_SHADOW_LOG: '/shadow',
  }, () => {
    expect(controllerLaunch(root)).toMatchObject({
      controller: 'front-door',
      command: ['/front-door'],
      environment: { GARCON_RS_CONTROLLER: 'original', GARCON_RS_SHADOW_LOG: '/shadow' },
    });
  });
  withEnvironment({
    GARCON_TEST_CONTROLLER: 'rust',
    GARCON_TEST_RUST_CONTROLLER_BINARY: undefined,
    GARCON_TEST_FRONT_DOOR_BINARY: '/front-door',
    GARCON_RS_CONTROLLER: 'original',
    GARCON_RS_SHADOW_LOG: '/shadow',
  }, () => {
    expect(controllerLaunch(root)).toMatchObject({
      controller: 'rust',
      command: ['/checkout/rust/target/release/garcon-server'],
      environment: { GARCON_RS_CONTROLLER: 'native', GARCON_RS_SHADOW_LOG: '/shadow' },
    });
    process.env.GARCON_TEST_RUST_CONTROLLER_BINARY = '/rust-controller';
    expect(controllerLaunch(root).command).toEqual(['/rust-controller']);
  });
  withEnvironment({ GARCON_TEST_CONTROLLER: 'invalid' }, () => {
    expect(() => controllerLaunch(root)).toThrow('Unknown controller: invalid');
  });
});

test('worker selection resolves the binary for serving and revealing credentials', () => {
  withEnvironment({ GARCON_TEST_WORKER: undefined, GARCON_TEST_RUST_EXECUTOR_BINARY: '/disabled' }, () => {
    expect(executorCommand(root)).toEqual([process.execPath, 'server/main.ts', 'executor']);
    process.env.GARCON_TEST_WORKER = 'original';
    expect(executorCommand(root)).toEqual([process.execPath, 'server/main.ts', 'executor']);
  });
  withEnvironment({ GARCON_TEST_WORKER: 'rust', GARCON_TEST_RUST_EXECUTOR_BINARY: undefined }, () => {
    expect(executorCommand(root)).toEqual(['/checkout/rust/target/release/garcon-executor']);
    process.env.GARCON_TEST_RUST_EXECUTOR_BINARY = '/rust-executor';
    expect(executorCommand(root)).toEqual(['/rust-executor']);
  });
  withEnvironment({ GARCON_TEST_WORKER: 'invalid' }, () => {
    expect(() => executorCommand(root)).toThrow('Unknown worker: invalid');
  });
});

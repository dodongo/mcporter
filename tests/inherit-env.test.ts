import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { normalizeServerEntry } from '../src/config-normalize.js';
import { connectionIdentity, effectiveDefinition } from '../src/daemon/connection-identity.js';

const stdio = (overrides: Partial<ServerDefinition> = {}): ServerDefinition => ({
  name: 'proxy',
  command: { kind: 'stdio', command: process.execPath, args: [], cwd: os.tmpdir() },
  lifecycle: { mode: 'keep-alive' },
  inheritEnv: ['HOME'],
  ...overrides,
});

const session = (id: string, path: string): NodeJS.ProcessEnv => ({
  HOME: '/home/user',
  PATH: path,
  PI_SESSION_ID: id,
  TOKEN: 'secret',
});

describe('inheritEnv', () => {
  it('passes only the listed ambient variables and the explicit env to the server', async () => {
    const definition = await effectiveDefinition(
      stdio({ env: { API_TOKEN: '${TOKEN}', FIXED: 'one' } }),
      session('a', '/a/bin')
    );
    expect(definition.env).toEqual({
      HOME: '/home/user',
      API_TOKEN: 'secret',
      FIXED: 'one',
      PWD: definition.command.kind === 'stdio' ? definition.command.cwd : undefined,
    });
  });

  it('shares one connection between callers that differ only in variables the server does not inherit', async () => {
    const first = await effectiveDefinition(stdio(), session('a', '/a/bin'));
    const second = await effectiveDefinition(stdio(), session('b', '/b/bin'));
    expect(connectionIdentity(first)).toBe(connectionIdentity(second));
  });

  it('separates connections when an inherited variable differs', async () => {
    const first = await effectiveDefinition(stdio(), session('a', '/a/bin'));
    const second = await effectiveDefinition(stdio(), { ...session('a', '/a/bin'), HOME: '/home/other' });
    expect(connectionIdentity(first)).not.toBe(connectionIdentity(second));
  });

  it('inherits the whole ambient environment when absent', async () => {
    const definition = await effectiveDefinition(stdio({ inheritEnv: undefined }), session('a', '/a/bin'));
    expect(definition.env).toMatchObject(session('a', '/a/bin'));
  });

  it('is read from the config entry', () => {
    const source = { kind: 'local' as const, path: '/tmp/mcporter.json' };
    const definition = normalizeServerEntry(
      'proxy',
      { command: 'node', inheritEnv: ['HOME', 'TMPDIR'] },
      os.tmpdir(),
      source,
      [source]
    );
    expect(definition.inheritEnv).toEqual(['HOME', 'TMPDIR']);
  });
});

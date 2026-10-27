import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { connectionIdentity, effectiveDefinition } from '../src/daemon/connection-identity.js';

const http = (overrides: Partial<ServerDefinition> = {}): ServerDefinition => ({
  name: 'remote',
  command: {
    kind: 'http',
    url: new URL('https://mcp.example.com/mcp'),
    headers: { Authorization: 'Bearer ${REMOTE_TOKEN}', 'X-Team': '$env:REMOTE_TEAM' },
  },
  ...overrides,
});

const identity = async (definition: ServerDefinition, env: NodeJS.ProcessEnv) =>
  connectionIdentity(await effectiveDefinition(definition, env));

describe('HTTP connection identity', () => {
  const base = { HOME: '/home/user', REMOTE_TOKEN: 'token', REMOTE_TEAM: 'team', SECRET_SOURCE: 'secret' };

  it('ignores caller location and session variables', async () => {
    expect(await identity(http(), { ...base, PWD: '/a', SHLVL: '1', TERM_SESSION_ID: 'x' })).toBe(
      await identity(http(), { ...base, PWD: '/b', SHLVL: '3', TERM_SESSION_ID: 'y' })
    );
  });

  it.each([
    ['a header placeholder', 'REMOTE_TOKEN', http()],
    ['a direct header reference', 'REMOTE_TEAM', http()],
    ['an *Env field', 'SECRET_SOURCE', http({ oauthClientSecretEnv: 'SECRET_SOURCE' })],
    ['a configured env entry', 'SECRET_SOURCE', http({ env: { SECRET_SOURCE: '${SECRET_SOURCE}' } })],
    ['a process-wide network setting', 'HTTPS_PROXY', http()],
    ['the home directory', 'HOME', http()],
  ])('separates connections when %s changes', async (_label, key, definition) => {
    expect(await identity(definition, { ...base, [key]: 'first' })).not.toBe(
      await identity(definition, { ...base, [key]: 'second' })
    );
  });

  it('keeps PATH only for definitions that run an OAuth command', async () => {
    const command = http({ oauthCommand: { args: ['login'] } });
    expect(await identity(http(), { ...base, PATH: '/a' })).toBe(await identity(http(), { ...base, PATH: '/b' }));
    expect(await identity(command, { ...base, PATH: '/a' })).not.toBe(await identity(command, { ...base, PATH: '/b' }));
  });
});

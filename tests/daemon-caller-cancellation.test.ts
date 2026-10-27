import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureResult, singletonFixture } from './helpers/singleton.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureNextSockets(): net.Socket[] {
  const sockets: net.Socket[] = [];
  const connect = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
    const socket = connect(...args);
    sockets.push(socket);
    return socket;
  }) as typeof net.createConnection);
  return sockets;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition not reached.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('does not send a call whose caller disconnected while its connection started', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client();
    const sockets = captureNextSockets();
    const abandoned = client.callTool({ server: 'fixture', tool: 'identity' }).catch((error: unknown) => error);
    await waitFor(async () => f.host.status().servers.length > 0);
    vi.restoreAllMocks();
    for (const socket of sockets) socket.destroy(new Error('caller exited'));
    await abandoned;
    expect(fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' })).count).toBe(1);
  } finally {
    await f.close();
  }
});

it('sends MCP cancellation for an active call whose caller disconnected', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client();
    await client.callTool({ server: 'fixture', tool: 'identity' });
    const sockets = captureNextSockets();
    const abandoned = client.callTool({ server: 'fixture', tool: 'delayed' }).catch((error: unknown) => error);
    const effects = path.join(f.root, 'effects');
    await waitFor(async () => (await fs.readFile(effects, 'utf8').catch(() => '')).includes('once'));
    vi.restoreAllMocks();
    for (const socket of sockets) socket.destroy(new Error('caller exited'));
    await abandoned;
    await waitFor(
      async () => (await fs.readFile(path.join(f.root, 'cancellations'), 'utf8').catch(() => '')) === 'delayed\n'
    );
    expect(fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' })).count).toBe(3);
  } finally {
    await f.close();
  }
});

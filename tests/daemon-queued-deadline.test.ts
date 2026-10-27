import { expect, it } from 'vitest';
import { fixtureResult, singletonFixture } from './helpers/singleton.js';

it('does not send a queued call whose deadline passed while an earlier call held the connection', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client();
    await client.callTool({ server: 'fixture', tool: 'identity' });
    const slow = client.callTool({ server: 'fixture', tool: 'delayed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(client.callTool({ server: 'fixture', tool: 'identity', timeoutMs: 100 })).rejects.toMatchObject({
      code: 'operation_expired',
    });
    await slow;
    expect(fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' })).count).toBe(3);
  } finally {
    await f.close();
  }
});

it('gives a queued call only the time left before its deadline', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client();
    await client.callTool({ server: 'fixture', tool: 'identity' });
    const slow = client.callTool({ server: 'fixture', tool: 'delayed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(client.callTool({ server: 'fixture', tool: 'delayed', timeoutMs: 400 })).rejects.toMatchObject({
      code: 'operation_timeout',
    });
    await slow;
  } finally {
    await f.close();
  }
});

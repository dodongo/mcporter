import { expect, it } from 'vitest';
import type { CallProgress } from '../src/daemon/protocol.js';
import { singletonFixture } from './helpers/singleton.js';

it('keeps a call alive while the server reports progress and passes the progress to the caller', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client();
    await client.callTool({ server: 'fixture', tool: 'identity' });
    const seen: CallProgress[] = [];
    await client.callTool({ server: 'fixture', tool: 'progressing', timeoutMs: 250 }, (progress) =>
      seen.push(progress)
    );
    expect(seen).toEqual([1, 2, 3, 4].map((step) => ({ progress: step, total: 4, message: `step ${step}` })));
    await expect(client.callTool({ server: 'fixture', tool: 'delayed', timeoutMs: 150 })).rejects.toMatchObject({
      code: 'operation_timeout',
    });
  } finally {
    await f.close();
  }
});

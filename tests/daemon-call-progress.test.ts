import { expect, it } from 'vitest';
import type { CallProgress } from '../src/daemon/protocol.js';
import { singletonFixture } from './helpers/singleton.js';

it('passes server progress through the daemon to the caller while the call runs', async () => {
  const f = await singletonFixture();
  try {
    const seen: CallProgress[] = [];
    const releases: Promise<unknown>[] = [];
    await f.client().callTool({ server: 'fixture', tool: 'progressing' }, (progress) => {
      seen.push(progress);
      releases.push(f.client().callTool({ server: 'fixture', tool: 'release' }));
    });
    await Promise.all(releases);
    expect(seen).toEqual([{ progress: 1, total: 2, message: 'waiting' }]);
  } finally {
    await f.close();
  }
});

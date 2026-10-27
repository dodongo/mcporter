import { afterEach, expect, it, vi } from 'vitest';
import { SdkErrorCode } from '@modelcontextprotocol/client';
import { DaemonBroker } from '../src/daemon/broker.js';
import type { CallOptions } from '../src/runtime.js';
import { createRuntime } from '../src/runtime.js';

vi.mock('../src/runtime.js', () => ({ createRuntime: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const connected = Promise.withResolvers<void>();
  connected.resolve();
  const state = { connected: connected.promise };
  const callTool = vi.fn(async (_server: string, _tool: string, _options?: CallOptions): Promise<unknown> => 'ok');
  const close = vi.fn(async () => {});
  vi.mocked(createRuntime).mockImplementation(
    async () =>
      ({
        connect: async () => {
          await state.connected;
          return { transport: {}, client: {} };
        },
        callTool,
        close,
      }) as unknown as Awaited<ReturnType<typeof createRuntime>>
  );
  const broker = new DaemonBroker();
  const handle = broker.register({
    definitions: [
      {
        name: 'fixture',
        command: { kind: 'stdio', command: process.execPath, args: [], cwd: process.cwd() },
        lifecycle: { mode: 'keep-alive' },
      },
    ],
  });
  const invoke = (
    params: { deadlineAt?: number } = {},
    signal?: AbortSignal,
    onProgress?: (progress: { progress: number }) => void
  ) =>
    broker.invokeWithNotices(
      { id: 'call', method: 'callTool', params: { server: 'fixture', tool: 'identity', ...params }, ...handle },
      signal,
      onProgress
    );
  const holdConnection = () => {
    const held = Promise.withResolvers<void>();
    state.connected = held.promise;
    return held.resolve;
  };
  return { broker, callTool, close, invoke, holdConnection };
}

function holdCall(f: ReturnType<typeof fixture>) {
  const held = Promise.withResolvers<unknown>();
  f.callTool.mockImplementationOnce(() => held.promise);
  return held.resolve;
}

it('sends calls on one connection without waiting for earlier calls', async () => {
  const f = fixture();
  try {
    const finishFirst = holdCall(f);
    const finishSecond = holdCall(f);
    const calls = [f.invoke(), f.invoke()];
    await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(2));
    finishFirst('first');
    finishSecond('second');
    expect((await Promise.all(calls)).map(({ result }) => result)).toEqual(['first', 'second']);
    expect(createRuntime).toHaveBeenCalledTimes(1);
  } finally {
    await f.broker.close();
  }
});

it('does not send a call whose deadline passed while its connection started', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const connect = f.holdConnection();
    const call = f.invoke({ deadlineAt: Date.now() + 100 });
    const outcome = expect(call).rejects.toMatchObject({ code: 'operation_expired' });
    await vi.advanceTimersByTimeAsync(150);
    connect();
    await outcome;
    expect(f.callTool).not.toHaveBeenCalled();
  } finally {
    await f.broker.close();
  }
});

it('gives a call only the time left after its connection started', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const connect = f.holdConnection();
    const call = f.invoke({ deadlineAt: Date.now() + 100 });
    await vi.advanceTimersByTimeAsync(40);
    connect();
    await call;
    expect(f.callTool.mock.calls[0]?.[2]?.timeoutMs).toBe(60);
  } finally {
    await f.broker.close();
  }
});

it('does not send a call whose caller disconnected while its connection started', async () => {
  const f = fixture();
  try {
    const connect = f.holdConnection();
    const caller = new AbortController();
    const call = f.invoke({}, caller.signal);
    caller.abort();
    connect();
    await expect(call).rejects.toMatchObject({ code: 'operation_cancelled' });
    expect(f.callTool).not.toHaveBeenCalled();
  } finally {
    await f.broker.close();
  }
});

it('cancels an active call when its caller disconnects and keeps the outcome unknown', async () => {
  const f = fixture();
  try {
    f.callTool.mockImplementationOnce(
      (_server, _tool, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { code: SdkErrorCode.RequestTimeout }))
          )
        )
    );
    const caller = new AbortController();
    const call = f.invoke({}, caller.signal);
    await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(1));
    caller.abort();
    await expect(call).rejects.toMatchObject({ code: 'operation_cancelled' });
    expect(f.broker.canIdleShutdown()).toBe(false);
  } finally {
    await f.broker.close();
  }
});

it('passes server progress to the caller', async () => {
  const f = fixture();
  try {
    f.callTool.mockImplementationOnce(async (_server, _tool, options) => {
      options?.onProgress?.({ progress: 1, total: 2, message: 'half' });
      return 'ok';
    });
    const seen: unknown[] = [];
    await f.invoke({}, undefined, (progress) => seen.push(progress));
    expect(seen).toEqual([{ progress: 1, total: 2, message: 'half' }]);
  } finally {
    await f.broker.close();
  }
});

it('reconnects a closed connection only after the calls still on it settle', async () => {
  const f = fixture();
  try {
    const finishActive = holdCall(f);
    const active = f.invoke();
    await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(1));
    f.callTool.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: SdkErrorCode.ConnectionClosed }));
    await expect(f.invoke()).rejects.toThrow('closed');
    const next = f.invoke();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.callTool).toHaveBeenCalledTimes(2);
    expect(f.close).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(1);
    finishActive('done');
    await active;
    expect((await next).result).toBe('ok');
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  } finally {
    await f.broker.close();
  }
});

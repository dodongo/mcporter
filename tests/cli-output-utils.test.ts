import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { printCallOutput, tailLogIfRequested } from '../src/cli/output-utils.js';
import { createCallResult } from '../src/result-utils.js';

function demo() {}

describe('printCallOutput format selection', () => {
  it.each([
    [
      'auto prefers json payloads when available',
      'auto',
      {
        content: [
          { type: 'text', text: 'fallback text' },
          { type: 'json', json: { source: 'json' } },
          { type: 'markdown', text: '# heading' },
        ],
      },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({ source: 'json' });
      },
    ],
    [
      'auto prints the full structuredContent object instead of only its data field',
      'auto',
      {
        structuredContent: {
          status: 'error',
          summary: 'Failed to create base: name is required',
          data: {},
          meta: {},
        },
        content: [
          {
            type: 'text',
            text: '{"status":"error","summary":"Failed to create base: name is required","data":{},"meta":{}}',
          },
        ],
      },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({
          status: 'error',
          summary: 'Failed to create base: name is required',
          data: {},
          meta: {},
        });
      },
    ],
    [
      'auto prints structuredContent nested inside a result wrapper',
      'auto',
      {
        result: {
          content: [
            {
              type: 'text',
              text: '{\n  "entities": [],\n  "relations": []\n}',
            },
          ],
          structuredContent: {
            entities: [],
            relations: [],
          },
        },
      },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({
          entities: [],
          relations: [],
        });
      },
    ],
    [
      'text prefers text over markdown/json',
      'text',
      {
        content: [
          { type: 'text', text: 'plain text wins' },
          { type: 'markdown', text: '# heading' },
          { type: 'json', json: { source: 'json' } },
        ],
      },
      (logged: unknown) => {
        expect(logged).toBe('plain text wins\n# heading');
      },
    ],
    [
      'markdown prefers markdown content',
      'markdown',
      {
        content: [
          { type: 'text', text: 'plain text' },
          { type: 'markdown', text: '## markdown wins' },
        ],
      },
      (logged: unknown) => {
        expect(logged).toBe('## markdown wins');
      },
    ],
    [
      'json falls back to raw output when no JSON candidate exists',
      'json',
      'raw-only-string',
      (logged: unknown) => {
        expect(logged).toBe('"raw-only-string"');
      },
    ],
    [
      'json emits valid JSON for object raw fallback instead of inspect output',
      'json',
      { content: [{ type: 'text', text: 'no json here' }] },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({ content: [{ type: 'text', text: 'no json here' }] });
      },
    ],
    [
      'json emits valid JSON for MCP error envelopes instead of inspect output',
      'json',
      { content: [{ type: 'text', text: 'MCP error -32602: Tool search not found' }], isError: true },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({
          content: [{ type: 'text', text: 'MCP error -32602: Tool search not found' }],
          isError: true,
        });
      },
    ],
    [
      'json emits null for undefined raw fallback',
      'json',
      undefined,
      (logged: unknown) => {
        expect(logged).toBe('null');
      },
    ],
    [
      'json emits a JSON string when raw fallback is circular',
      'json',
      (() => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        return circular;
      })(),
      (logged: unknown) => {
        expect(typeof logged).toBe('string');
        expect(() => JSON.parse(String(logged))).not.toThrow();
      },
    ],
    [
      'raw prints inspect output even when json exists',
      'raw',
      { content: [{ type: 'json', json: { id: 1 } }] },
      (logged: unknown) => {
        expect(String(logged)).toContain("type: 'json'");
      },
    ],
    [
      'auto falls back to readable raw output for plain object payloads',
      'auto',
      { result: 'Available pages for facebook/react' },
      (logged: unknown) => {
        expect(String(logged)).toContain("result: 'Available pages for facebook/react'");
      },
    ],
  ] as const)('%s', (_name, format, raw, assertLogged) => {
    const wrapped = createCallResult(raw);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      printCallOutput(wrapped, raw, format);
      expect(log).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls[0]?.[0];
      assertLogged(logged);
    } finally {
      log.mockRestore();
    }
  });
});

describe('printCallOutput envelope output', () => {
  it('prints the whole MCP result as JSON where json keeps only the structured value', () => {
    const raw = {
      isError: true,
      structuredContent: { id: 1 },
      content: [
        { type: 'text', text: 'note' },
        { type: 'resource_link', uri: 'file:///report', name: 'report' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printCallOutput(createCallResult(raw), raw, 'json');
      printCallOutput(createCallResult(raw), raw, 'envelope');
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ id: 1 });
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual(raw);
    } finally {
      log.mockRestore();
    }
  });
});

describe('printCallOutput raw output', () => {
  it('does not truncate long strings when printing raw output', () => {
    const longText = 'x'.repeat(15000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const raw = { t: longText };
    const wrapped = createCallResult(raw);

    try {
      printCallOutput(wrapped, raw, 'raw');

      expect(log).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls[0]?.[0];
      expect(typeof logged).toBe('string');
      expect(logged).not.toContain('... 5000 more characters');
      expect(logged).toContain(longText.slice(-50));
    } finally {
      log.mockRestore();
    }
  });

  it('prints nested values beyond the default inspect depth', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const raw = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  leaf: 'done',
                },
              },
            },
          },
        },
      },
    };
    const wrapped = createCallResult(raw);

    try {
      printCallOutput(wrapped, raw, 'raw');

      expect(log).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls[0]?.[0];
      expect(typeof logged).toBe('string');
      expect(logged).toContain("leaf: 'done'");
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [12n, '12'],
    [Symbol.for('demo'), 'Symbol(demo)'],
    [demo, 'function demo() {}'],
  ])('prints primitive raw value %s explicitly', (raw, expected) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printCallOutput(createCallResult(raw), raw, 'raw');
      expect(log).toHaveBeenCalledWith(expected);
    } finally {
      log.mockRestore();
    }
  });

  it('falls back from an unserializable JSON candidate to readable raw output', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const wrapped = {
      json: () => circular,
      markdown: () => null,
      text: () => null,
    } as unknown as ReturnType<typeof createCallResult>;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printCallOutput(wrapped, { fallback: true }, 'auto');
      expect(String(log.mock.calls[0]?.[0])).toContain('self: [Circular');
    } finally {
      log.mockRestore();
    }
  });
});

describe('tailLogIfRequested', () => {
  it.runIf(process.platform !== 'win32')('does not block when a regular log is replaced by a FIFO', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-fifo-'));
    const regular = path.join(dir, 'regular.log');
    const fifo = path.join(dir, 'pipe.log');
    try {
      await fsPromises.writeFile(regular, 'regular file');
      execFileSync('mkfifo', [fifo]);
      const script = `
import fs from 'node:fs';
import { tailLogIfRequested } from ${JSON.stringify(new URL('../src/cli/output-utils.ts', import.meta.url).href)};
const stat = fs.statSync(process.env.MCPORTER_TEST_REGULAR);
const original = fs.statSync;
fs.statSync = (...args) => args[0] === process.env.MCPORTER_TEST_FIFO ? stat : original(...args);
tailLogIfRequested({ logFile: process.env.MCPORTER_TEST_FIFO }, true);
`;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        timeout: 5000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        env: { ...process.env, MCPORTER_TEST_REGULAR: regular, MCPORTER_TEST_FIFO: fifo },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toContain('Refusing to tail non-file log path');
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads only the final MiB of a large log', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-bounded-'));
    const logPath = path.join(dir, 'large.log');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.spyOn(fs, 'readSync');
    try {
      await fsPromises.writeFile(logPath, `${'x'.repeat(2 * 1024 * 1024)}\nlast line\n`);
      tailLogIfRequested({ logFile: logPath }, true);
      expect(log).toHaveBeenCalledWith('last line');
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]?.[1].byteLength).toBe(1024 * 1024);
    } finally {
      vi.restoreAllMocks();
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('prints only the final twenty lines from recognized absolute log paths', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-log-'));
    const logPath = path.join(dir, 'server.log');
    await fsPromises.writeFile(logPath, Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      tailLogIfRequested({ logFile: logPath }, true);
      expect(log).toHaveBeenCalledWith(`--- tail ${logPath} ---`);
      expect(log).not.toHaveBeenCalledWith('line-5');
      expect(log).toHaveBeenCalledWith('line-6');
      expect(log).toHaveBeenCalledWith('line-25');
    } finally {
      log.mockRestore();
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('decodes only the bytes actually read when the log shrinks after stat', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-short-'));
    const logPath = path.join(dir, 'server.log');
    await fsPromises.writeFile(logPath, 'abc\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readSync = vi.spyOn(fs, 'readSync').mockImplementation(((
      _fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number
    ) => {
      const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      return Buffer.from('xyz').copy(target, offset ?? 0);
    }) as typeof fs.readSync);
    try {
      tailLogIfRequested({ logFile: logPath }, true);
      const printed = log.mock.calls.map((call) => String(call[0]));
      expect(printed).toContain('xyz');
      expect(printed.some((line) => line.includes('\0'))).toBe(false);
    } finally {
      log.mockRestore();
      readSync.mockRestore();
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores disabled and non-object inputs and warns for unsafe, missing, or unreadable paths', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-errors-'));
    const missing = path.join(dir, 'missing.log');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      tailLogIfRequested({ logPath: missing }, false);
      tailLogIfRequested(null, true);
      tailLogIfRequested({ logPath: 'relative.log', logfile: missing, logFile: dir }, true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refusing to tail non-absolute log path'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Log path not found'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refusing to tail non-file log path'));
    } finally {
      warn.mockRestore();
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

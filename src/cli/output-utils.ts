import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import type { CallResult } from '../result-utils.js';
import { logWarn } from './logger-context.js';

export type OutputFormat = 'auto' | 'text' | 'markdown' | 'json' | 'raw' | 'envelope';
const RAW_INSPECT_DEPTH = 8;
const TAIL_LOG_LINE_COUNT = 20;
const TAIL_LOG_MAX_BYTES = 1024 * 1024;

type RenderableKind = 'json' | 'markdown' | 'text' | 'raw';

interface RenderableOutput {
  kind: RenderableKind;
  value: unknown;
}

const PREFERRED_OUTPUT_BY_FORMAT: Record<OutputFormat, RenderableKind[]> = {
  auto: ['json', 'markdown', 'text', 'raw'],
  text: ['text', 'markdown', 'json', 'raw'],
  markdown: ['markdown', 'text', 'json', 'raw'],
  json: ['json', 'raw'],
  raw: ['raw'],
  envelope: ['raw'],
};

export function printCallOutput<T>(wrapped: CallResult<T>, raw: T, format: OutputFormat): void {
  const preferredKinds = PREFERRED_OUTPUT_BY_FORMAT[format];
  const renderable = resolveRenderableOutput(wrapped, raw, preferredKinds);
  emitRenderableOutput(renderable, format);
}

export function tailLogIfRequested(result: unknown, enabled: boolean): void {
  // Some transports still encode log paths inside tool results; tail when explicitly asked.
  if (!enabled) {
    return;
  }
  const candidates: string[] = [];
  if (result && typeof result === 'object') {
    const possibleKeys = ['logPath', 'logFile', 'logfile'];
    for (const key of possibleKeys) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        candidates.push(value);
      }
    }
  }

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      logWarn(`Refusing to tail non-absolute log path: ${candidate}`);
      continue;
    }
    if (!fs.existsSync(candidate)) {
      logWarn(`Log path not found: ${candidate}`);
      continue;
    }
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) {
        logWarn(`Refusing to tail non-file log path: ${candidate}`);
        continue;
      }
      const tail = readLastLogLines(candidate, TAIL_LOG_LINE_COUNT);
      console.log(`--- tail ${candidate} ---`);
      for (const line of tail) {
        console.log(line);
      }
    } catch (error) {
      logWarn(`Failed to read log file ${candidate}: ${(error as Error).message}`);
    }
  }
}

function readLastLogLines(filePath: string, lineCount: number): string[] {
  // A log may be replaced after the path check; opening a FIFO must not block.
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error('Refusing to tail non-file log path');
    const readSize = Math.min(stats.size, TAIL_LOG_MAX_BYTES);
    const start = stats.size - readSize;
    const buffer = Buffer.alloc(readSize);
    const bytesRead = fs.readSync(fd, buffer, 0, readSize, start);
    if (bytesRead <= 0) {
      return [];
    }
    const lines = buffer.subarray(0, bytesRead).toString('utf8').trimEnd().split(/\r?\n/);
    return lines.slice(-lineCount);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveRenderableOutput<T>(
  wrapped: CallResult<T>,
  raw: T,
  preferredKinds: RenderableKind[]
): RenderableOutput {
  for (const kind of preferredKinds) {
    if (kind === 'json') {
      const jsonValue = wrapped.json();
      if (jsonValue !== null) {
        return { kind, value: jsonValue };
      }
      continue;
    }
    if (kind === 'markdown') {
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        return { kind, value: markdown };
      }
      continue;
    }
    if (kind === 'text') {
      const text = wrapped.text();
      if (typeof text === 'string') {
        return { kind, value: text };
      }
      continue;
    }
    if (kind === 'raw') {
      return { kind, value: raw };
    }
  }
  return { kind: 'raw', value: raw };
}

function emitRenderableOutput(renderable: RenderableOutput, requestedFormat?: OutputFormat): void {
  if (renderable.kind === 'json') {
    if (!attemptPrintJson(renderable.value)) {
      printRaw(renderable.value, requestedFormat);
    }
    return;
  }
  if (renderable.kind === 'markdown' || renderable.kind === 'text') {
    console.log(String(renderable.value));
    return;
  }
  printRaw(renderable.value, requestedFormat);
}

function attemptPrintJson(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  try {
    if (value === null) {
      console.log('null');
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
    return true;
  } catch {
    return false;
  }
}

function printRaw(raw: unknown, requestedFormat?: OutputFormat): void {
  if (requestedFormat === 'json' || requestedFormat === 'envelope') {
    try {
      const serialized = JSON.stringify(raw, null, 2);
      console.log(typeof serialized === 'string' ? serialized : 'null');
    } catch {
      console.log(JSON.stringify(String(raw)));
    }
    return;
  }

  if (typeof raw === 'string') {
    console.log(raw);
    return;
  }
  if (raw === null) {
    console.log('null');
    return;
  }
  if (raw === undefined) {
    console.log('undefined');
    return;
  }
  if (typeof raw === 'bigint') {
    console.log(raw.toString());
    return;
  }
  if (typeof raw === 'symbol' || typeof raw === 'function') {
    console.log(raw.toString());
    return;
  }
  // Keep nested payloads readable without unbounded inspect walks on huge objects.
  console.log(inspect(raw, { depth: RAW_INSPECT_DEPTH, maxStringLength: null, breakLength: 80 }));
}

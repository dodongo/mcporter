import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const original = childProcess.spawnSync;
const destination = process.env.MCPORTER_PROOF_DIAGNOSTICS;
const record = (row) => fs.appendFileSync(destination, JSON.stringify(row) + '\n', { mode: 0o600 });
childProcess.spawnSync = function (...args) {
  if (!destination || path.basename(String(args[0])).toLowerCase() !== 'powershell.exe') {
    return original.apply(this, args);
  }
  const start = performance.now();
  record({ phase: 'powershell-begin', node: process.version, pid: process.pid, at: new Date().toISOString() });
  const result = original.apply(this, args);
  const raw = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  record({ phase: 'powershell-end', pid: process.pid, elapsedMs: performance.now() - start,
    status: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    safeStage: /^[A-Za-z0-9_.:=\- ]{1,240}$/u.test(raw) ? raw : null });
  return result;
};
syncBuiltinESMExports();

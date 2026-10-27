import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isExistingChromeDevtoolsCommand } from '../chrome-devtools-command.js';
import {
  resolveChromeDevtoolsRelayEnvironment,
  resolveChromeDevtoolsRelayPolicy,
  resolveChromeDevtoolsRelayProbeTimeoutMs,
} from '../chrome-devtools-relay.js';
import type { ServerDefinition } from '../config.js';
import { stableJsonStringify } from '../stable-json.js';
import { resolveCommandArgument, resolveCommandArguments } from '../runtime/utils.js';
import { childEnvWithoutVaultSecrets } from '../oauth-vault-encryption.js';

// These are broker controls, never child inputs. Other environment differences remain meaningful.
const BROKER_ENV = new Set([
  'MCPORTER_DAEMON_DIR',
  'MCPORTER_DAEMON_CHILD',
  'MCPORTER_DAEMON_SOCKET',
  'MCPORTER_DAEMON_METADATA',
  'MCPORTER_CONFIG',
  'MCPORTER_DISABLE_AUTORUN',
  'MCPORTER_DAEMON_LOG',
  'MCPORTER_DAEMON_LOG_PATH',
  'MCPORTER_DAEMON_LOG_SERVERS',
  'MCPORTER_NO_FORCE_EXIT',
]);

const HTTP_PROCESS_ENV =
  /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z0-9_]+|MCPORTER_[A-Z0-9_]+|NODE_[A-Z0-9_]+|SSL_CERT_(?:FILE|DIR)|(?:HTTPS?|NO|ALL)_PROXY)$/i;
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_DIRECT_PREFIX = '$env:';

export interface ResolvedServerDefinition extends ServerDefinition {
  /** Resolved explicit overrides, before adding inherited launch environment. */
  readonly configuredEnv?: Record<string, string>;
  /** Requested executable before canonical PATH resolution; never a pooling input. */
  readonly launchCommand?: string;
}

export async function effectiveDefinition(
  definition: ServerDefinition,
  inherited: NodeJS.ProcessEnv = process.env,
  purpose: 'connection' | 'view' = 'connection'
): Promise<ResolvedServerDefinition> {
  // The inherited environment loses the vault password and policy before it
  // reaches any daemon-managed child; an explicit `env` entry still wins.
  const env = Object.fromEntries(
    Object.entries(
      resolveChromeDevtoolsRelayEnvironment(definition.env, childEnvWithoutVaultSecrets(inherited))
    ).filter(([key, value]) => value !== undefined && !BROKER_ENV.has(key))
  ) as Record<string, string>;
  const configuredEnv = Object.fromEntries(
    Object.keys(definition.env ?? {})
      .filter((key) => !BROKER_ENV.has(key))
      .map((key) => [key, env[key] ?? ''])
  );
  normalizeChromeEnvironment(definition, env);
  const chrome = isExistingChromeDefinition(definition, env);
  const launchCommand =
    definition.command.kind === 'stdio' ? resolveCommandArgument(definition.command.command, env) : undefined;
  const command =
    definition.command.kind === 'stdio'
      ? {
          ...definition.command,
          command:
            chrome && purpose === 'view'
              ? launchCommand!
              : await resolveExecutable(launchCommand!, env, definition.command.cwd),
          args: resolveCommandArguments(definition.command.args, env),
          cwd: await fs.realpath(definition.command.cwd),
        }
      : { ...definition.command, url: new URL(definition.command.url) };
  // Shell location and nesting describe the caller, not the configured child.
  if (command.kind === 'stdio') {
    if (!Object.hasOwn(configuredEnv, 'PWD')) env.PWD = command.cwd;
    if (!Object.hasOwn(configuredEnv, 'SHLVL')) delete env.SHLVL;
  }
  return { ...definition, command, env, configuredEnv, ...(chrome ? { launchCommand } : {}) };
}

export function normalizeChromeEnvironment(definition: ServerDefinition, env: Record<string, string>): void {
  if (isExistingChromeDefinition(definition, env)) {
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY = resolveChromeDevtoolsRelayPolicy(definition.chromeDevtoolsRelay, env);
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS = String(resolveChromeDevtoolsRelayProbeTimeoutMs(env));
    delete env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY;
    if (!env.OPENCLAW_PROFILE?.trim() || env.OPENCLAW_PROFILE.trim() === 'default') delete env.OPENCLAW_PROFILE;
    if (env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL?.trim())
      env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL = new URL(env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL.trim()).toString();
    else delete env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL;
  }
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const roots = /[/\\]/.test(command)
    ? [path.resolve(cwd, command)]
    : (env.PATH ?? env.Path ?? '').split(path.delimiter).map((dir) => path.resolve(cwd, dir, command));
  const extensions =
    process.platform === 'win32' && !path.extname(command)
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  const candidates = roots.flatMap((root) => extensions.map((extension) => root + extension));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error('Unable to resolve configured executable from the effective PATH.');
}

export function connectionIdentity(definition: ResolvedServerDefinition): string {
  const {
    name,
    description: _description,
    source: _source,
    sources: _sources,
    allowedTools: _allowed,
    blockedTools: _blocked,
    lifecycle: _lifecycle,
    configuredEnv: _configuredEnv,
    launchCommand: _launchCommand,
    logging: _logging,
    ...connection
  } = definition;
  // HTTP cached credentials are alias-owned even when auth was inferred on first use.
  const credentialOwner = definition.auth || definition.command.kind === 'http' ? name : undefined;
  const env = definition.command.kind === 'http' ? httpTransportEnv(definition) : { ...definition.env };
  const chrome = isExistingChromeDefinition(definition);
  if (chrome) {
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY = resolveChromeDevtoolsRelayPolicy(definition.chromeDevtoolsRelay, env);
    delete env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY;
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS = String(resolveChromeDevtoolsRelayProbeTimeoutMs(env));
  }
  return createHash('sha256')
    .update(
      stableJsonStringify({
        ...connection,
        env,
        credentialOwner,
        idleTimeoutMs:
          !chrome && definition.lifecycle?.mode === 'keep-alive' ? definition.lifecycle.idleTimeoutMs : undefined,
        protocolVersion: definition.protocolVersion ?? 'auto',
        httpFetch: definition.httpFetch ?? 'default',
        chromeDevtoolsRelay: chrome ? env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY : undefined,
      })
    )
    .digest('hex');
}

function httpTransportEnv(definition: ResolvedServerDefinition): Record<string, string> {
  const { env, configuredEnv, ...rest } = definition;
  const referenced = new Set(Object.keys(configuredEnv ?? {}));
  if (definition.oauthCommand) referenced.add('PATH');
  const visit = (value: unknown, key: string): void => {
    if (value instanceof URL) visit(value.href, key);
    else if (typeof value === 'string') {
      if (key.endsWith('Env')) referenced.add(value);
      if (value.startsWith(ENV_DIRECT_PREFIX)) referenced.add(value.slice(ENV_DIRECT_PREFIX.length));
      for (const match of value.matchAll(ENV_PLACEHOLDER)) referenced.add(match[1]!);
    } else if (value && typeof value === 'object')
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(rest, '');
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => referenced.has(key) || HTTP_PROCESS_ENV.test(key))
  );
}

/** Plain launches own their browser; connection selectors and ambiguous wrappers do not prove isolation. */
export function isExistingChromeDefinition(definition: ServerDefinition, env?: NodeJS.ProcessEnv): boolean {
  if (definition.command.kind !== 'stdio') return false;
  const effectiveEnv = env ?? resolveChromeDevtoolsRelayEnvironment(definition.env);
  const command = resolveCommandArgument(definition.command.command, effectiveEnv);
  const args = resolveCommandArguments(definition.command.args, effectiveEnv);
  return (
    [definition.name, command, ...args].some((value) => /chrome[-_]devtools(?:[-_]mcp)?/i.test(value)) &&
    isExistingChromeDevtoolsCommand(command, args)
  );
}

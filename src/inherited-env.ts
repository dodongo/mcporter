import type { ServerDefinition } from './config-schema.js';

export function inheritedServerEnv(
  definition: Pick<ServerDefinition, 'env' | 'inheritEnv'>,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (!definition.inheritEnv) return env;
  const kept = new Set([...definition.inheritEnv, ...Object.keys(definition.env ?? {})]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => kept.has(key)));
}

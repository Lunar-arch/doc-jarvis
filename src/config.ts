/**
 * Configuration loader — merges defaults, config.json, and environment variables.
 * Priority: env > config.json > defaults
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from './types.js';

const DEFAULTS: AppConfig = {
  trigger_keyword: '@jarvis',
  drive_search_keyword: 'jarvis',
  poll_interval_ms: 10_000,
  stream_interval_ms: 500,
  openclaw: {
    gateway_url: 'http://localhost:18789',
    gateway_token: '',
    session_key: '',
    model: 'openclaw',
  },
  google: {
    client_id: '',
    client_secret: '',
    redirect_uri: 'http://localhost:8080/oauth2callback',
    token_path: './tokens/google-token.json',
  },
  prompt_delimiter: {
    start: '@jarvis',
    end_pattern: '\\n\\n',
  },
};

function loadEnv(): Partial<AppConfig> {
  const env = process.env;
  const overrides: Partial<AppConfig> = {};

  if (env.GOOGLE_CLIENT_ID) {
    overrides.google = { ...overrides.google, ...{ client_id: env.GOOGLE_CLIENT_ID } } as AppConfig['google'];
  }
  if (env.GOOGLE_CLIENT_SECRET) {
    overrides.google = { ...overrides.google, ...{ client_secret: env.GOOGLE_CLIENT_SECRET } } as AppConfig['google'];
  }
  if (env.OPENCLAW_GATEWAY_URL) {
    overrides.openclaw = { ...overrides.openclaw, ...{ gateway_url: env.OPENCLAW_GATEWAY_URL } } as AppConfig['openclaw'];
  }
  if (env.OPENCLAW_GATEWAY_TOKEN) {
    overrides.openclaw = { ...overrides.openclaw, ...{ gateway_token: env.OPENCLAW_GATEWAY_TOKEN } } as AppConfig['openclaw'];
  }

  return overrides;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] as Record<string, unknown> ?? {}, value as Record<string, unknown>);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

export function loadConfig(configPath = 'config.json'): AppConfig {
  let fileConfig: Partial<AppConfig> = {};
  try {
    const raw = readFileSync(resolve(configPath), 'utf-8');
    fileConfig = JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    // config.json doesn't exist yet — use defaults + env
  }

  const envConfig = loadEnv();
  const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig as Record<string, unknown>);
  const finalConfig = deepMerge(merged, envConfig as Record<string, unknown>);

  return finalConfig as unknown as AppConfig;
}

/** Validate that required config fields are present. Throws on missing. */
export function validateConfig(config: AppConfig): void {
  const errors: string[] = [];

  if (!config.google.client_id) errors.push('google.client_id is required');
  if (!config.google.client_secret) errors.push('google.client_secret is required');
  if (!config.openclaw.gateway_url) errors.push('openclaw.gateway_url is required');
  if (!config.trigger_keyword) errors.push('trigger_keyword is required');

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  ${errors.join('\n  ')}`);
  }
}
import fs from 'node:fs';
import path from 'node:path';

export interface ModelRouteConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyFile?: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export interface GatewayConfig {
  chat: ModelRouteConfig;
  summary: ModelRouteConfig;
  embedding?: ModelRouteConfig;
  rerank?: ModelRouteConfig;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
}

type Environment = Record<string, string | undefined>;

function stringEnv(environment: Environment, name: string, fallback: string): string {
  const value = environment[name]?.trim();
  return value || fallback;
}

function positiveInt(
  environment: Environment,
  name: string,
  fallback: number,
  allowZero = false
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const valid = Number.isInteger(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid)
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}

function nonNegativeNumber(environment: Environment, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function optionalRoute(
  environment: Environment,
  prefix: string,
  defaults: { provider: string; model: string; baseUrl: string }
): ModelRouteConfig | undefined {
  const baseUrl = environment[`${prefix}_BASE_URL`]?.trim();
  const model = environment[`${prefix}_MODEL`]?.trim();
  if (!baseUrl && !model) return undefined;
  return route(environment, prefix, {
    provider: stringEnv(environment, `${prefix}_PROVIDER`, defaults.provider),
    model: model || defaults.model,
    baseUrl: baseUrl || defaults.baseUrl
  });
}

function route(
  environment: Environment,
  prefix: string,
  defaults: { provider: string; model: string; baseUrl: string }
): ModelRouteConfig {
  return {
    provider: defaults.provider,
    model: defaults.model,
    baseUrl: normalizeBaseUrl(defaults.baseUrl),
    apiKey: environment[`${prefix}_API_KEY`]?.trim() || undefined,
    apiKeyFile: environment[`${prefix}_API_KEY_FILE`]?.trim() || undefined,
    inputPricePerMillion: nonNegativeNumber(environment, `${prefix}_INPUT_PRICE_PER_MILLION`, 0),
    outputPricePerMillion: nonNegativeNumber(environment, `${prefix}_OUTPUT_PRICE_PER_MILLION`, 0)
  };
}

export function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('Model base URL must use http or https');
  return normalized;
}

export function resolveApiKey(routeConfig: ModelRouteConfig): string {
  if (routeConfig.apiKey) return routeConfig.apiKey;
  if (!routeConfig.apiKeyFile) {
    throw new Error(`API key is not configured for ${routeConfig.provider}`);
  }
  const keyPath = path.resolve(routeConfig.apiKeyFile);
  const key = fs
    .readFileSync(keyPath, 'utf8')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!key) throw new Error(`API key file is empty: ${keyPath}`);
  if (/\r|\n/.test(key)) throw new Error(`API key file must contain one token: ${keyPath}`);
  return key;
}

export function loadGatewayConfig(environment: Environment = process.env): GatewayConfig {
  const baseUrl = stringEnv(environment, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com');
  const provider = stringEnv(environment, 'DEEPSEEK_PROVIDER', 'deepseek');
  const chatModel = stringEnv(environment, 'DEEPSEEK_CHAT_MODEL', 'deepseek-v4-flash');
  const summaryModel = stringEnv(environment, 'DEEPSEEK_SUMMARY_MODEL', chatModel);
  const shared = {
    provider,
    baseUrl: normalizeBaseUrl(baseUrl)
  };
  const chat = route(environment, 'DEEPSEEK', { ...shared, model: chatModel });
  const summary = route(environment, 'DEEPSEEK_SUMMARY', {
    ...shared,
    model: summaryModel
  });
  if (environment.DEEPSEEK_SUMMARY_INPUT_PRICE_PER_MILLION === undefined) {
    summary.inputPricePerMillion = chat.inputPricePerMillion;
  }
  if (environment.DEEPSEEK_SUMMARY_OUTPUT_PRICE_PER_MILLION === undefined) {
    summary.outputPricePerMillion = chat.outputPricePerMillion;
  }
  if (!summary.apiKey && !summary.apiKeyFile) {
    summary.apiKey = chat.apiKey;
    summary.apiKeyFile = chat.apiKeyFile;
  }

  return {
    chat,
    summary,
    embedding: optionalRoute(environment, 'EMBEDDING', {
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      baseUrl: 'https://api.openai.com/v1'
    }),
    rerank: optionalRoute(environment, 'RERANK', {
      provider: 'openai-compatible',
      model: 'rerank-v3.5',
      baseUrl: 'https://api.jina.ai/v1'
    }),
    timeoutMs: positiveInt(environment, 'MODEL_TIMEOUT_MS', 120_000),
    maxRetries: positiveInt(environment, 'MODEL_MAX_RETRIES', 2, true),
    retryBaseDelayMs: positiveInt(environment, 'MODEL_RETRY_BASE_DELAY_MS', 250, true),
    circuitFailureThreshold: positiveInt(environment, 'MODEL_CIRCUIT_FAILURE_THRESHOLD', 3),
    circuitCooldownMs: positiveInt(environment, 'MODEL_CIRCUIT_COOLDOWN_MS', 10_000),
    maxResponseBytes: positiveInt(environment, 'MODEL_MAX_RESPONSE_BYTES', 4 * 1024 * 1024),
    maxOutputTokens: positiveInt(environment, 'MODEL_MAX_OUTPUT_TOKENS', 8_000)
  };
}

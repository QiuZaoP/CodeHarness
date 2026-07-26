import type { ModelRouteConfig, GatewayConfig } from './config.ts';
import { ModelGatewayError } from './errors.ts';
import { isAbortError, isRetryableFailure } from './errors.ts';

export interface HeaderCollection {
  get(name: string): string | null;
}

export interface ResponseBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface ResponseBody {
  getReader(): ResponseBodyReader;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: HeaderCollection;
  text(): Promise<string>;
  body?: ResponseBody | null;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<HttpResponse>;
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });

export const defaultFetch: FetchLike = async (url, init) => {
  const fetchFunction = globalThis.fetch;
  if (!fetchFunction) throw new Error('Global fetch is unavailable');
  return (await fetchFunction(url, init as never)) as unknown as HttpResponse;
};

export class ProviderHttpError extends ModelGatewayError {
  constructor(
    status: number,
    provider: string,
    requestId?: string,
    retryAfterMs?: number,
    providerCode?: string
  ) {
    const category = status === 429 ? 'RATE_LIMIT' : 'PROVIDER';
    super(
      `Model provider returned HTTP ${status}`,
      category,
      {
        provider,
        status,
        requestId,
        retryAfterMs,
        providerCode,
        retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
      },
      status === 429 ? 429 : status >= 500 ? 502 : 400
    );
  }
}

function header(response: HttpResponse, name: string): string | undefined {
  return response.headers.get(name) ?? response.headers.get(name.toLowerCase()) ?? undefined;
}

function retryAfterMs(response: HttpResponse): number | undefined {
  const value = header(response, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export async function assertResponse(response: HttpResponse, route: ModelRouteConfig): Promise<void> {
  if (response.ok) return;
  // Consume the body without returning it. Provider error payloads can contain user prompts or
  // credentials echoed by an upstream proxy, so they are intentionally not propagated.
  const body = await response.text().catch(() => '');
  let providerCode: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } };
    const error = parsed?.error;
    const code = typeof error?.code === 'string' ? error.code : error?.type;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) providerCode = code;
  } catch {
    // Keep provider bodies opaque when they are not a safe structured error object.
  }
  throw new ProviderHttpError(
    response.status,
    route.provider,
    header(response, 'x-request-id') ?? header(response, 'request-id'),
    retryAfterMs(response),
    providerCode
  );
}

export async function readJson(response: HttpResponse, maxBytes: number): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new ModelGatewayError('Model response exceeded the configured size limit', 'INVALID_RESPONSE', {
      maxResponseBytes: maxBytes
    }, 502);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ModelGatewayError('Model provider returned invalid JSON', 'INVALID_RESPONSE', {}, 502);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelGatewayError('Model provider returned an invalid response object', 'INVALID_RESPONSE', {}, 502);
  }
  return parsed as Record<string, unknown>;
}

export async function withRetries<T>(
  action: (attempt: number) => Promise<T>,
  options: {
    maxRetries: number;
    baseDelayMs: number;
    signal: AbortSignal;
    sleep?: Sleep;
    onRetry?: () => void;
  }
): Promise<{ value: T; retries: number }> {
  const sleep = options.sleep ?? defaultSleep;
  let retries = 0;
  while (true) {
    if (options.signal.aborted) throw options.signal.reason;
    try {
      return { value: await action(retries), retries };
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      if (isAbortError(error) || !isRetryableFailure(error) || retries >= options.maxRetries) {
        throw error;
      }
      const details = error instanceof ModelGatewayError && error.details && typeof error.details === 'object'
        ? (error.details as { retryAfterMs?: unknown })
        : {};
      const retryAfter = typeof details.retryAfterMs === 'number' ? details.retryAfterMs : undefined;
      const delay = retryAfter ?? options.baseDelayMs * 2 ** retries;
      retries += 1;
      options.onRetry?.();
      await sleep(delay, options.signal);
    }
  }
}

export async function withTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal,
  timeoutMs: number
): Promise<T> {
  if (externalSignal.aborted) throw externalSignal.reason;
  const controller = new AbortController();
  let timedOut = false;
  let rejectExternal: (reason?: unknown) => void = () => undefined;
  const abortFromCaller = () => {
    controller.abort(externalSignal.reason);
    rejectExternal(externalSignal.reason);
  };
  externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const timeout = new ModelGatewayError('Model request timed out', 'TIMEOUT', { timeoutMs }, 504);
      controller.abort(timeout);
      reject(timeout);
    }, timeoutMs);
  });
  const externalAbortPromise = new Promise<never>((_, reject) => {
    rejectExternal = reject;
    if (externalSignal.aborted) reject(externalSignal.reason);
  });
  try {
    return await Promise.race([action(controller.signal), timeoutPromise, externalAbortPromise]);
  } catch (error) {
    if (externalSignal.aborted) throw externalSignal.reason;
    if (timedOut) throw new ModelGatewayError('Model request timed out', 'TIMEOUT', { timeoutMs }, 504);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal.removeEventListener('abort', abortFromCaller);
  }
}

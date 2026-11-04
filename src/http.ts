/**
 * Unified HTTP layer for GLPI REST API.
 *
 * - Single `request()` entry point used by every domain call.
 * - Auto re-authentication on 401 (expired session_token).
 * - Session renewal on a 403 ERROR_RIGHT_MISSING read: GLPI computes the
 *   session's entity scope at login, so an entity created afterwards stays
 *   out of reach until a new session is opened (issue #13). At most one
 *   renewal per `rightsRefreshIntervalMs`, so a real missing right does not
 *   open a session per call.
 * - `onSessionStart` runs on every new session (first login, renewal), so the
 *   client can restore the active profile and entity it had chosen.
 * - Structured errors with HTTP status, GLPI error code/message, and full body.
 * - Retries: GET is retried after a network error, a timeout or a 5xx.
 *   POST/PUT/DELETE are retried only after a connection-level error raised
 *   before the request was sent (ECONNREFUSED, ENOTFOUND, EAI_AGAIN), never
 *   after a timeout or a 5xx (the write may have been applied). 429 is retried
 *   for every method. Delays are capped at 30 s and get ±20 % jitter.
 * - A process-wide semaphore caps the number of in-flight GLPI calls.
 */

export interface GlpiHttpConfig {
  url: string;
  appToken?: string;
  userToken?: string;
  username?: string;
  password?: string;
  /** Max retry attempts on 5xx (default 2). */
  maxRetries?: number;
  /** Initial backoff in ms (default 300). */
  retryBaseDelayMs?: number;
  /** Request timeout in ms (default 15000), body read included. */
  timeoutMs?: number;
  /** Max concurrent in-flight GLPI calls (default env GLPI_MAX_CONCURRENCY or 8). */
  maxConcurrency?: number;
  /**
   * Minimum age of the session before a 403 ERROR_RIGHT_MISSING on a read
   * renews it (default 60000 ms; 0 renews on every such 403).
   */
  rightsRefreshIntervalMs?: number;
}

/** Called with the new token right after `initSession`, before any caller uses it. */
export type SessionStartHook = (sessionToken: string) => Promise<void>;

/** Upper bound of any retry delay (backoff or Retry-After). */
export const MAX_RETRY_DELAY_MS = 30_000;

/** Raised when a GLPI call (headers or body) exceeds `timeoutMs`. */
export class GlpiTimeoutError extends Error {
  constructor(timeoutMs: number, url: string) {
    super(`Request timeout after ${timeoutMs}ms: ${url}`);
    this.name = 'GlpiTimeoutError';
  }
}

const PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * True when a fetch failure happened before any byte of the request reached
 * the server (DNS failure, connection refused), so replaying a write is safe.
 * Node's fetch wraps the socket error in `TypeError('fetch failed', { cause })`,
 * and the cause may itself be an AggregateError (happy eyeballs).
 */
export function isPreSendError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
  if (typeof e.code === 'string' && PRE_SEND_ERROR_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every((x) => isPreSendError(x, depth + 1))) {
    return true;
  }
  return isPreSendError(e.cause, depth + 1);
}

/** Apply the 30 s cap then ±20 % jitter. */
export function retryDelay(baseMs: number, random: () => number = Math.random): number {
  const capped = Math.min(Math.max(0, baseMs), MAX_RETRY_DELAY_MS);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(capped * jitter);
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

/** Minimal counting semaphore (FIFO). */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next waiter (active count unchanged).
    if (next) next();
    else this.active--;
  }
}

function defaultConcurrency(): number {
  const raw = process.env.GLPI_MAX_CONCURRENCY;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8;
}

export interface GlpiRawError {
  status: number;
  glpiCode?: string;
  glpiMessage?: string;
  body: string;
  url: string;
  method: string;
}

export class GlpiError extends Error {
  readonly status: number;
  readonly glpiCode?: string;
  readonly glpiMessage?: string;
  readonly body: string;
  readonly url: string;
  readonly method: string;

  constructor(raw: GlpiRawError) {
    const detail = raw.glpiCode
      ? `${raw.glpiCode}${raw.glpiMessage ? ': ' + raw.glpiMessage : ''}`
      : raw.body.slice(0, 500);
    super(`GLPI ${raw.method} ${raw.url} -> ${raw.status} (${detail})`);
    this.name = 'GlpiError';
    this.status = raw.status;
    this.glpiCode = raw.glpiCode;
    this.glpiMessage = raw.glpiMessage;
    this.body = raw.body;
    this.url = raw.url;
    this.method = raw.method;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query parameters, appended to the URL. */
  query?: URLSearchParams | Record<string, string | number | boolean | undefined>;
  /** JSON body, sent as `Content-Type: application/json`. */
  json?: unknown;
  /** Multipart body (file uploads). Content-Type is set by fetch with the boundary. */
  form?: FormData;
  /** Skip auto session init/reauth (used internally for initSession/killSession). */
  noSession?: boolean;
  /** Override auth header (used by initSession). */
  authHeader?: string;
  /** Explicit Session-Token to send (used by killSession). */
  sessionToken?: string;
  /** Capture response headers in the result. */
  withHeaders?: boolean;
}

interface FetchedResponse {
  response: Response;
  /** Body, read inside the timed region. */
  body: string;
}

export interface RequestResult<T> {
  data: T;
  headers: Headers;
  status: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GLPI error code of an error body (`["ERROR_CODE", "message"]`). */
export function glpiErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

function parseJson<T>(text: string): T {
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Debug logging to stderr (stdout is reserved for the MCP stdio transport). */
function debugLog(message: string): void {
  if (process.env.GLPI_DEBUG) {
    console.error(`[glpi-http] ${new Date().toISOString()} ${message}`);
  }
}

export class GlpiHttp {
  readonly config: GlpiHttpConfig;
  private sessionToken: string | null = null;
  /**
   * In-flight `initSession`, if any.
   *
   * Callers can be concurrent (the HTTP transport serves one request per
   * connection, and the GLPI client is shared process-wide), and without this
   * each of them would open its own GLPI session and overwrite the token,
   * leaking the sessions it abandoned.
   */
  private sessionInit: Promise<string> | null = null;
  /** When the current session was opened (ms epoch), 0 before the first one. */
  private sessionStartedAt = 0;
  private readonly slots: Semaphore;
  /** See `SessionStartHook`; set by GlpiClient. */
  onSessionStart?: SessionStartHook;

  constructor(config: GlpiHttpConfig) {
    this.config = {
      maxRetries: 2,
      retryBaseDelayMs: 300,
      timeoutMs: 15000,
      rightsRefreshIntervalMs: 60_000,
      ...config,
      url: config.url.replace(/\/$/, ''),
    };
    this.slots = new Semaphore(this.config.maxConcurrency ?? defaultConcurrency());
  }

  get session(): string | null {
    return this.sessionToken;
  }

  async initSession(): Promise<string> {
    if (!this.sessionInit) {
      this.sessionInit = this.requestNewSession().finally(() => {
        this.sessionInit = null;
      });
    }
    return this.sessionInit;
  }

  private async requestNewSession(): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.appToken) headers['App-Token'] = this.config.appToken;

    if (this.config.userToken) {
      headers['Authorization'] = `user_token ${this.config.userToken}`;
    } else if (this.config.username && this.config.password) {
      const credentials = Buffer.from(
        `${this.config.username}:${this.config.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else {
      throw new Error(
        'No authentication method provided. Set userToken or username/password.'
      );
    }

    const url = `${this.config.url}/apirest.php/initSession`;
    const { response, body } = await this.fetchWithTimeout(url, { method: 'GET', headers });

    if (!response.ok) {
      throw this.buildError(response, body, 'GET', url);
    }

    let token: unknown;
    try {
      token = (JSON.parse(body) as { session_token?: unknown })?.session_token;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string' || token.trim() === '') {
      throw new Error(`GLPI initSession returned no session_token (HTTP ${response.status}): ${body.slice(0, 200)}`);
    }
    this.sessionToken = token;
    this.sessionStartedAt = Date.now();
    if (this.onSessionStart) {
      try {
        await this.onSessionStart(token);
      } catch (err) {
        // The session works, only the restored context is missing: say so, go on.
        console.error(`Warning: could not restore the session context: ${err instanceof Error ? err.message : err}`);
      }
    }
    return token;
  }

  /**
   * Replace the session `usedToken` with a new one, unless another caller
   * already did. The old session is closed in the background.
   */
  private async renewSession(usedToken: string | undefined): Promise<void> {
    if (this.sessionToken === usedToken) {
      this.sessionToken = null;
      if (usedToken) {
        void this.request('killSession', { noSession: true, sessionToken: usedToken }).catch(() => undefined);
      }
    }
    if (!this.sessionToken) await this.initSession();
  }

  /**
   * Close the current GLPI session. Uses the token we hold as-is: never
   * re-authenticates just to log out (a 401 here means it is already dead).
   */
  async killSession(): Promise<void> {
    const token = this.sessionToken;
    if (!token) return;
    try {
      await this.request('killSession', { noSession: true, sessionToken: token });
    } catch {
      // ignore: the session is gone or GLPI is unreachable
    }
    if (this.sessionToken === token) this.sessionToken = null;
  }

  private async ensureSession(): Promise<void> {
    if (!this.sessionToken) await this.initSession();
  }

  /**
   * fetch + body read under one timer and one concurrency slot, so a server
   * that sends headers then stalls the body cannot hang the caller forever.
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<FetchedResponse> {
    const timeoutMs = this.config.timeoutMs ?? 15000;
    await this.slots.acquire();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await response.text();
      return { response, body };
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new GlpiTimeoutError(timeoutMs, url);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      this.slots.release();
    }
  }

  /**
   * Unified GLPI request.
   * - `path` is appended to `{baseUrl}/apirest.php/`. Do NOT URL-encode upfront.
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<RequestResult<T>> {
    const method = options.method ?? 'GET';

    if (!options.noSession) await this.ensureSession();

    const headers: Record<string, string> = {};
    // For multipart, fetch sets Content-Type itself (with the boundary).
    if (!options.form) headers['Content-Type'] = 'application/json';
    if (this.config.appToken) headers['App-Token'] = this.config.appToken;
    const explicitToken = options.sessionToken;
    if (explicitToken) headers['Session-Token'] = explicitToken;
    else if (this.sessionToken && !options.authHeader) headers['Session-Token'] = this.sessionToken;
    if (options.authHeader) headers['Authorization'] = options.authHeader;

    const queryString = this.buildQuery(options.query);
    const fullUrl = `${this.config.url}/apirest.php/${path}${queryString ? '?' + queryString : ''}`;

    const init: RequestInit = { method, headers };
    if (options.form) init.body = options.form;
    else if (options.json !== undefined) init.body = JSON.stringify(options.json);

    const idempotent = method === 'GET';
    const maxRetries = this.config.maxRetries ?? 2;
    const baseDelay = this.config.retryBaseDelayMs ?? 300;
    let attempt = 0;
    let reauthAttempted = false;
    let rightsRetried = false;

    for (;;) {
      // Token actually sent with this attempt (for the concurrent-401 guard).
      const usedToken = headers['Session-Token'];
      let fetched: FetchedResponse;
      try {
        fetched = await this.fetchWithTimeout(fullUrl, init);
      } catch (err) {
        const retryable = idempotent
          ? true
          : !(err instanceof GlpiTimeoutError) && isPreSendError(err);
        if (retryable && attempt < maxRetries) {
          const delay = retryDelay(baseDelay * Math.pow(2, attempt));
          debugLog(`${method} ${path} network error (${err instanceof Error ? err.message : err}), retry in ${delay}ms`);
          await sleep(delay);
          attempt++;
          continue;
        }
        throw err;
      }
      const { response, body } = fetched;

      if (response.ok) {
        return { data: parseJson<T>(body), headers: response.headers, status: response.status };
      }

      // 401 -> session likely expired. Reauth once, retry once. Only drop the
      // session if nobody refreshed it since this request was sent; otherwise
      // a concurrent caller already did and we just retry with the new token.
      if (response.status === 401 && !reauthAttempted && !options.noSession) {
        reauthAttempted = true;
        if (this.sessionToken === usedToken) {
          this.sessionToken = null;
          debugLog(`${method} ${path} -> 401, re-authenticating`);
        }
        if (!this.sessionToken) await this.initSession();
        if (this.sessionToken) headers['Session-Token'] = this.sessionToken;
        continue;
      }

      // 403 ERROR_RIGHT_MISSING on a read -> the session's entity scope may
      // be stale (entity created after login, issue #13). Retry once with a
      // newer session: one another caller opened, or a new one if ours is
      // old enough. Writes are not retried: GLPI checks their rights the same
      // way, but replaying a write is never automatic here.
      if (
        response.status === 403 &&
        idempotent &&
        !rightsRetried &&
        !options.noSession &&
        glpiErrorCode(body) === 'ERROR_RIGHT_MISSING'
      ) {
        rightsRetried = true;
        const renewedMeanwhile = this.sessionToken !== null && this.sessionToken !== usedToken;
        const age = Date.now() - this.sessionStartedAt;
        if (renewedMeanwhile || age >= (this.config.rightsRefreshIntervalMs ?? 60_000)) {
          if (!renewedMeanwhile) debugLog(`${method} ${path} -> 403 ERROR_RIGHT_MISSING, renewing the session`);
          await this.renewSession(usedToken);
          if (this.sessionToken) headers['Session-Token'] = this.sessionToken;
          continue;
        }
      }

      // 429 -> honour Retry-After (capped), else exponential backoff. Every
      // method: a rate-limited request was not processed.
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const delay = retryDelay(retryAfter ?? baseDelay * Math.pow(2, attempt));
        debugLog(`${method} ${path} -> 429 rate-limited, retry in ${delay}ms`);
        await sleep(delay);
        attempt++;
        continue;
      }

      // 5xx -> backoff retry, GET only (a write may already be applied).
      if (response.status >= 500 && idempotent && attempt < maxRetries) {
        const delay = retryDelay(baseDelay * Math.pow(2, attempt));
        debugLog(`${method} ${path} -> ${response.status}, retry in ${delay}ms`);
        await sleep(delay);
        attempt++;
        continue;
      }

      throw this.buildError(response, body, method, fullUrl);
    }
  }

  private buildError(response: Response, body: string, method: string, url: string): GlpiError {
    let glpiCode: string | undefined;
    let glpiMessage: string | undefined;
    try {
      const parsed = JSON.parse(body);
      // GLPI returns errors as ["ERROR_CODE", "message"]
      if (Array.isArray(parsed) && parsed.length >= 1 && typeof parsed[0] === 'string') {
        glpiCode = parsed[0];
        glpiMessage = typeof parsed[1] === 'string' ? parsed[1] : undefined;
      }
    } catch {
      // body is not JSON; leave glpiCode/Message undefined
    }
    return new GlpiError({
      status: response.status,
      glpiCode,
      glpiMessage,
      body,
      url,
      method,
    });
  }

  private buildQuery(
    query: RequestOptions['query']
  ): string {
    if (!query) return '';
    if (query instanceof URLSearchParams) return query.toString();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    return params.toString();
  }
}

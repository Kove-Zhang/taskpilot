import { fetch } from '@tauri-apps/plugin-http'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Default layered timeout policy for an individual LLM provider request. */
export const DEFAULT_LLM_TIMEOUT_POLICY = {
  connectTimeoutMs: 60_000,
  firstByteTimeoutMs: 60_000,
  totalTimeoutMs: 180 * 1_000,
} as const
/** Backward-compatible total timeout constant. */
export const LLM_REQUEST_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_POLICY.totalTimeoutMs

export type TimeoutPhase = 'connect' | 'first_byte' | 'total'
export interface RequestTimeoutPolicy {
  connectTimeoutMs: number
  firstByteTimeoutMs: number
  totalTimeoutMs: number
}

export class HttpRequestError extends Error {
  readonly status?: number
  readonly isTimeout: boolean
  readonly isRetryable: boolean
  readonly retryAfterMs?: number
  readonly isCancelled: boolean
  readonly timeoutPhase?: TimeoutPhase
  /** Non-secret request correlation ID when the transport provides one. */
  readonly requestId?: string
  /** Non-secret operation correlation ID shared by all attempts in one LLM call. */
  readonly traceId?: string

  constructor(message: string, options: { status?: number; isTimeout?: boolean; isRetryable?: boolean; retryAfterMs?: number; isCancelled?: boolean; timeoutPhase?: TimeoutPhase; requestId?: string; traceId?: string } = {}) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = options.status
    this.isTimeout = options.isTimeout ?? false
    this.isRetryable = options.isRetryable ?? false
    this.retryAfterMs = options.retryAfterMs
    this.isCancelled = options.isCancelled ?? false
    this.timeoutPhase = options.timeoutPhase
    this.requestId = options.requestId
    this.traceId = options.traceId
  }
}

export function createCancellationError(message = '请求已取消'): HttpRequestError {
  return new HttpRequestError(message, { isCancelled: true, isRetryable: false })
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof HttpRequestError && error.isCancelled
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createCancellationError()
}

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  getAbortError: () => HttpRequestError = createCancellationError,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(getAbortError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(getAbortError())
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { cleanup(); resolve(value) },
      (error) => { cleanup(); reject(error) },
    )
  })
}

function normalizeTimeoutPolicy(timeout: number | RequestTimeoutPolicy): RequestTimeoutPolicy {
  if (typeof timeout === 'number') {
    const safeTimeout = Math.max(1, timeout)
    return { connectTimeoutMs: safeTimeout, firstByteTimeoutMs: safeTimeout, totalTimeoutMs: safeTimeout }
  }
  return {
    connectTimeoutMs: Math.max(1, timeout.connectTimeoutMs),
    firstByteTimeoutMs: Math.max(1, timeout.firstByteTimeoutMs),
    totalTimeoutMs: Math.max(1, timeout.totalTimeoutMs),
  }
}

function bindResponseMethod<T extends (...args: any[]) => any>(
  response: Response,
  method: T | undefined,
): T | undefined {
  return typeof method === 'function' ? method.bind(response) as T : undefined
}

function wrapResponseBodyWithLifecycle(
  response: Response,
  controller: AbortController,
  cleanup: () => void,
  getAbortError: () => HttpRequestError,
): Response {
  // Do not use Object.create(response) here. Native Response properties such as
  // ok/status/headers perform an internal brand check and throw when accessed
  // with a non-Response receiver ("Illegal invocation"). Copy the response
  // metadata onto a plain object and keep body methods bound to the original.
  const wrapped = {
    body: response.body,
    bodyUsed: response.bodyUsed,
    headers: response.headers,
    ok: response.ok,
    redirected: response.redirected,
    status: response.status,
    statusText: response.statusText,
    type: response.type,
    url: response.url,
    arrayBuffer: bindResponseMethod(response, response.arrayBuffer),
    blob: bindResponseMethod(response, response.blob),
    clone: bindResponseMethod(response, response.clone),
    formData: bindResponseMethod(response, response.formData),
    json: async () => {
      try {
        return await raceWithAbort(response.json(), controller.signal, getAbortError)
      } finally {
        cleanup()
      }
    },
    text: async () => {
      try {
        return await raceWithAbort(response.text(), controller.signal, getAbortError)
      } finally {
        cleanup()
      }
    },
  } as unknown as Response
  return wrapped
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeout: number | RequestTimeoutPolicy = DEFAULT_REQUEST_TIMEOUT_MS,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  const policy = normalizeTimeoutPolicy(timeout)
  const externalSignal = options.signal ?? init.signal ?? undefined
  throwIfAborted(externalSignal)

  const controller = new AbortController()
  let timeoutPhase: TimeoutPhase = 'total'
  let externallyCancelled = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    window.clearTimeout(connectTimer)
    window.clearTimeout(firstByteTimer)
    window.clearTimeout(totalTimer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
  const onExternalAbort = () => {
    externallyCancelled = true
    controller.abort()
  }
  const createTimeoutError = () => new HttpRequestError(`请求超时（${Math.ceil((timeoutPhase === 'total' ? policy.totalTimeoutMs : timeoutPhase === 'first_byte' ? policy.firstByteTimeoutMs : policy.connectTimeoutMs) / 1000)} 秒，阶段：${timeoutPhase}）`, {
    isTimeout: true,
    timeoutPhase,
  })
  const connectTimer = window.setTimeout(() => {
    timeoutPhase = 'connect'
    controller.abort()
  }, policy.connectTimeoutMs)
  const firstByteTimer = window.setTimeout(() => {
    timeoutPhase = 'first_byte'
    controller.abort()
  }, policy.firstByteTimeoutMs)
  const totalTimer = window.setTimeout(() => {
    timeoutPhase = 'total'
    controller.abort()
  }, policy.totalTimeoutMs)

  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    } as RequestInit)
    // Fetch resolving means response headers are available; body parsing keeps
    // the total timer alive through the wrapped json/text method.
    window.clearTimeout(connectTimer)
    window.clearTimeout(firstByteTimer)
    return wrapResponseBodyWithLifecycle(response, controller, cleanup, () => (
      externallyCancelled || externalSignal?.aborted
        ? createCancellationError()
        : createTimeoutError()
    ))
  } catch (error) {
    cleanup()
    if (externallyCancelled || externalSignal?.aborted) throw createCancellationError()
    if (controller.signal.aborted) {
      throw createTimeoutError()
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

const RETRYABLE_TRANSPORT_ERROR_PATTERN = /network|fetch|socket|connection|abort(?:ed)?|dns|resolve|tls|ssl|certificate|econn|ehost|enotfound|eai_again|error\s+sending\s+(?:the\s+)?request|failed\s+to\s+send\s+(?:the\s+)?request|error\s+while\s+sending|request\s+(?:send(?:ing)?|error)|网络请求|网络连接|连接.*(?:失败|重置|拒绝)|无法解析|域名解析|证书|握手|读取.*响应|响应.*(?:utf-?8|编码)/i

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return ''
}

export function isRetryableTransportError(error: unknown): boolean {
  if (isCancellationError(error)) return false
  if (error instanceof HttpRequestError) {
    return error.isRetryable || error.isTimeout || RETRYABLE_TRANSPORT_ERROR_PATTERN.test(error.message)
  }
  return error instanceof TypeError || RETRYABLE_TRANSPORT_ERROR_PATTERN.test(getErrorMessage(error))
}

/**
 * Returns whether a request failed for a transient reason that is safe to retry.
 * Configuration, authentication and compatibility errors deliberately return false.
 */
export function isRetryableRequestError(error: unknown): boolean {
  if (error instanceof HttpRequestError && error.status !== undefined) {
    return isRetryableHttpStatus(error.status) || error.isRetryable || error.isTimeout
  }
  return isRetryableTransportError(error)
}

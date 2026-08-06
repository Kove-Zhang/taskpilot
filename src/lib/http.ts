import { fetch } from '@tauri-apps/plugin-http'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Timeout for an individual LLM provider request. */
export const LLM_REQUEST_TIMEOUT_MS = 3 * 60 * 1_000

export class HttpRequestError extends Error {
  readonly status?: number
  readonly isTimeout: boolean
  readonly isRetryable: boolean

  constructor(message: string, options: { status?: number; isTimeout?: boolean; isRetryable?: boolean } = {}) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = options.status
    this.isTimeout = options.isTimeout ?? false
    this.isRetryable = options.isRetryable ?? false
  }
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal } as RequestInit)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpRequestError(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`, { isTimeout: true })
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    window.clearTimeout(timer)
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

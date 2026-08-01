import { fetch } from '@tauri-apps/plugin-http'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class HttpRequestError extends Error {
  readonly status?: number
  readonly isTimeout: boolean

  constructor(message: string, options: { status?: number; isTimeout?: boolean } = {}) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = options.status
    this.isTimeout = options.isTimeout ?? false
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
  return status === 408 || status === 429 || status >= 500
}

export function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof HttpRequestError) return error.isTimeout
  return error instanceof TypeError || (error instanceof Error && /network|fetch|socket|connection/i.test(error.message))
}

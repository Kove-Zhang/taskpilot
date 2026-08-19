import { invoke } from '@tauri-apps/api/core'
import { HttpRequestError, fetchWithTimeout, isRetryableTransportError, raceWithAbort, DEFAULT_LLM_TIMEOUT_POLICY, type RequestTimeoutPolicy, type TimeoutPhase } from './http'
import type { ProviderRequest, ProviderResponse as LLMProviderResponse, ProviderTransportDiagnostics, ProviderTransportKind } from './llm/types'
import { logger } from './logger'

export type ProviderResponse = LLMProviderResponse

const transportDiagnosticsByError = new WeakMap<object, ProviderTransportDiagnostics>()

/** Returns only safe timing and transport metadata attached to a failed request. */
export function getProviderTransportDiagnostics(error: unknown): ProviderTransportDiagnostics | undefined {
  return error && typeof error === 'object' ? transportDiagnosticsByError.get(error) : undefined
}

function attachProviderTransportDiagnostics<T>(error: T, diagnostics: ProviderTransportDiagnostics): T {
  if (error && typeof error === 'object') transportDiagnosticsByError.set(error, diagnostics)
  return error
}

interface CustomProviderResponse {
  status: number
  body: string
  headers?: Record<string, string>
  requestId?: string
  traceId?: string
}

interface ProviderRequestOptions {
  baseUrl: string
  apiKey: string
  payload: Record<string, unknown>
  requestId?: string
  traceId?: string
  signal?: AbortSignal
  timeoutPolicy?: RequestTimeoutPolicy
}

export interface ProviderTransportRequestOptions {
  baseUrl: string
  apiKey: string
  request: ProviderRequest
  /** Reused by diagnostics, events and the custom Tauri cancellation registry. */
  requestId?: string
  /** Shared by all attempts that belong to the same LLM operation. */
  traceId?: string
  signal?: AbortSignal
  timeoutPolicy?: RequestTimeoutPolicy
}

const BUILTIN_PROVIDER_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'api.siliconflow.cn',
  'ai.chinatowercom.cn',
  'localhost',
  '127.0.0.1',
  '::1',
])

const CUSTOM_ERROR_PREFIX = /^\[custom-llm requestId=([A-Za-z0-9._:-]{1,120})(?: traceId=([A-Za-z0-9._:-]{1,120}))?\]\s*/

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function buildChatCompletionsEndpoint(baseUrl: string): string {
  const normalizedUrl = normalizeBaseUrl(baseUrl)
  if (!normalizedUrl) throw new Error('服务商未配置 API Base URL')
  return normalizedUrl.endsWith('/chat/completions')
    ? normalizedUrl
    : normalizedUrl + '/chat/completions'
}

export function usesCustomProvider(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return !BUILTIN_PROVIDER_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return true
  }
}

export function getProviderTransportKind(baseUrl: string): ProviderTransportKind {
  return usesCustomProvider(baseUrl) ? 'custom-rust' : 'tauri-http'
}

function createResponse(
  status: number,
  body: string,
  headerValues?: Record<string, string>,
  requestId?: string,
  traceId?: string,
): ProviderResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {}),
    headers: headerValues ? new Headers(headerValues) : undefined,
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}

function createCustomRequestId(): string {
  const suffix = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return 'custom-llm-' + suffix
}

function parseCustomTransportError(error: unknown, fallbackRequestId: string, fallbackTraceId?: string): {
  message: string
  requestId: string
  traceId?: string
  timeoutPhase?: TimeoutPhase
} {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const matched = rawMessage.match(CUSTOM_ERROR_PREFIX)
  const message = matched ? rawMessage.slice(matched[0].length) : rawMessage
  const timeoutPhase = /阶段：connect/i.test(message)
    ? 'connect'
    : /阶段：first_byte/i.test(message)
      ? 'first_byte'
      : /阶段：total/i.test(message)
        ? 'total'
        : undefined
  return {
    message,
    requestId: matched?.[1] ?? fallbackRequestId,
    traceId: matched?.[2] ?? fallbackTraceId,
    timeoutPhase,
  }
}

function wrapCustomTransportError(error: unknown, fallbackRequestId: string, fallbackTraceId?: string): HttpRequestError {
  if (error instanceof HttpRequestError) {
    if (error.requestId && (error.traceId || !fallbackTraceId)) return error
    return new HttpRequestError(error.message, {
      status: error.status,
      isTimeout: error.isTimeout,
      isRetryable: error.isRetryable,
      retryAfterMs: error.retryAfterMs,
      isCancelled: error.isCancelled,
      timeoutPhase: error.timeoutPhase,
      requestId: error.requestId ?? fallbackRequestId,
      traceId: error.traceId ?? fallbackTraceId,
    })
  }
  const { message, requestId, traceId, timeoutPhase } = parseCustomTransportError(error, fallbackRequestId, fallbackTraceId)
  const isTimeout = /超时|timeout|timed out/i.test(message)
  return new HttpRequestError('自定义服务商请求失败: ' + message, {
    isTimeout,
    isRetryable: isTimeout || isRetryableTransportError(error),
    timeoutPhase,
    requestId,
    traceId,
  })
}

export async function requestProviderRequest(options: ProviderTransportRequestOptions): Promise<ProviderResponse> {
  const requestBody = options.request.body
  const body = JSON.stringify(requestBody)
  void logger.prompt('提交至大模型的完整提示词', {
    model: requestBody.model,
    system: requestBody.system,
    messages: requestBody.messages,
  })

  if (!usesCustomProvider(options.baseUrl)) {
    const startedAt = Date.now()
    try {
      const response = await fetchWithTimeout(options.request.endpoint, {
        method: 'POST',
        headers: options.request.headers,
        body,
      }, options.timeoutPolicy ?? DEFAULT_LLM_TIMEOUT_POLICY, { signal: options.signal })
      return {
        ok: response.ok,
        status: response.status,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(options.traceId ? { traceId: options.traceId } : {}),
        headers: response.headers,
        transportDiagnostics: { transport: 'tauri-http', responseHeadersMs: Date.now() - startedAt },
        text: () => response.text(),
        json: () => response.json(),
      }
    } catch (error) {
      throw attachProviderTransportDiagnostics(error, { transport: 'tauri-http' })
    }
  }

  const requestId = options.requestId ?? createCustomRequestId()
  const onAbort = () => {
    // The AbortSignal must reach Rust as well as the foreground Promise. The
    // cancellation command is deliberately fire-and-forget so abort remains
    // immediate even if the command channel is under pressure.
    void invoke('cancel_custom_llm', { requestId }).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  try {
    const response = await raceWithAbort(invoke<CustomProviderResponse>('request_custom_llm', {
      request: {
        url: options.request.endpoint,
        apiKey: options.apiKey,
        payload: options.request.body,
        timeoutPolicy: options.timeoutPolicy,
        requestId,
        traceId: options.traceId,
      },
    }), options.signal)

    if (!response || typeof response.status !== 'number' || typeof response.body !== 'string') {
      throw new Error('Rust 代理返回数据结构异常')
    }
    const normalized = createResponse(
      response.status,
      response.body,
      response.headers,
      response.requestId ?? requestId,
      response.traceId ?? options.traceId,
    )
    return { ...normalized, transportDiagnostics: { transport: 'custom-rust' } }
  } catch (error) {
    throw attachProviderTransportDiagnostics(
      wrapCustomTransportError(error, requestId, options.traceId),
      { transport: 'custom-rust' },
    )
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Legacy OpenAI-compatible transport wrapper. New callers should build the
 * request with a ProviderAdapter and call requestProviderRequest instead.
 */
export async function requestProviderChatCompletion(options: ProviderRequestOptions): Promise<ProviderResponse> {
  return requestProviderRequest({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    requestId: options.requestId,
    traceId: options.traceId,
    signal: options.signal,
    timeoutPolicy: options.timeoutPolicy,
    request: {
      endpoint: buildChatCompletionsEndpoint(options.baseUrl),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + options.apiKey,
      },
      body: options.payload,
    },
  })
}

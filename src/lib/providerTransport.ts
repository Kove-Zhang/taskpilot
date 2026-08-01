import { invoke } from '@tauri-apps/api/core'
import { HttpRequestError, fetchWithTimeout, isRetryableTransportError } from './http'

export interface ProviderResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

interface CustomProviderResponse {
  status: number
  body: string
}

interface ProviderRequestOptions {
  baseUrl: string
  apiKey: string
  payload: Record<string, unknown>
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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function buildChatCompletionsEndpoint(baseUrl: string): string {
  const normalizedUrl = normalizeBaseUrl(baseUrl)
  if (!normalizedUrl) throw new Error('服务商未配置 API Base URL')
  return normalizedUrl.endsWith('/chat/completions')
    ? normalizedUrl
    : `${normalizedUrl}/chat/completions`
}

export function usesCustomProvider(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return !BUILTIN_PROVIDER_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return true
  }
}

function createResponse(status: number, body: string): ProviderResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}

function wrapCustomTransportError(error: unknown): HttpRequestError {
  const message = error instanceof Error ? error.message : String(error)
  const isTimeout = /超时|timeout|timed out/i.test(message)
  return new HttpRequestError(`自定义服务商请求失败: ${message}`, {
    isTimeout,
    isRetryable: isTimeout || isRetryableTransportError(error),
  })
}

export async function requestProviderChatCompletion(options: ProviderRequestOptions): Promise<ProviderResponse> {
  const endpoint = buildChatCompletionsEndpoint(options.baseUrl)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
  }
  const body = JSON.stringify(options.payload)

  if (!usesCustomProvider(options.baseUrl)) {
    return fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body,
    })
  }

  try {
    const response = await invoke<CustomProviderResponse>('request_custom_llm', {
      request: {
        url: endpoint,
        apiKey: options.apiKey,
        payload: options.payload,
      },
    })

    if (!response || typeof response.status !== 'number' || typeof response.body !== 'string') {
      throw new Error('Rust 代理返回数据结构异常')
    }
    return createResponse(response.status, response.body)
  } catch (error) {
    throw wrapCustomTransportError(error)
  }
}

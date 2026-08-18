import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { ProviderRequest } from './llm/types'
import { useSettingsStore } from '../store'
import {
  buildChatCompletionsEndpoint,
  requestProviderChatCompletion,
  requestProviderRequest,
  usesCustomProvider,
} from './providerTransport'

describe('provider transport', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    useSettingsStore.setState({ enableLogging: false, enablePromptLogging: false })
  })

  it('logs complete prompt messages only when both logging switches are enabled', async () => {
    useSettingsStore.setState({ enableLogging: true, enablePromptLogging: true })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await requestProviderChatCompletion({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'secret-api-key',
        payload: {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'user prompt with business data' },
          ],
        },
      })

      const promptLog = consoleSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('提交至大模型的完整提示词'))
      expect(promptLog).toContain('system prompt')
      expect(promptLog).toContain('user prompt with business data')
      expect(promptLog).not.toContain('secret-api-key')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('keeps built-in providers on the Tauri HTTP path', async () => {
    await expect(requestProviderChatCompletion({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      payload: { model: 'gpt-4o', messages: [] },
    })).resolves.toMatchObject({ ok: true })

    expect(invoke).not.toHaveBeenCalled()
  })

  it('routes arbitrary HTTPS providers through the Rust command and preserves allowlisted headers', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 429,
      body: '{"error":"rate limited"}',
      headers: { 'retry-after': '7', 'content-type': 'application/json', 'x-request-id': 'req-123' },
      requestId: 'custom-llm-test',
    })

    const response = await requestProviderChatCompletion({
      baseUrl: 'https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp',
      apiKey: 'test-key',
      payload: { model: 'qwen-plus', messages: [] },
    })

    expect(response.ok).toBe(false)
    expect(response.headers?.get('retry-after')).toBe('7')
    expect(response.headers?.get('content-type')).toBe('application/json')
    expect(response.headers?.get('x-request-id')).toBe('req-123')
    expect(invoke).toHaveBeenCalledWith('request_custom_llm', expect.objectContaining({
      request: expect.objectContaining({
        url: 'https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp/chat/completions',
        requestId: expect.stringMatching(/^custom-llm-/),
      }),
    }))
  })



  it('cancels an in-flight custom Rust request when AbortSignal fires', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'cancel_custom_llm') return true
      return new Promise(() => undefined)
    })
    const controller = new AbortController()
    const promise = requestProviderChatCompletion({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      payload: { model: 'test', messages: [] },
      signal: controller.signal,
    })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'HttpRequestError', isCancelled: true })
    expect(invoke).toHaveBeenCalledWith('cancel_custom_llm', expect.objectContaining({ requestId: expect.stringMatching(/^custom-llm-/) }))
  })

  it('passes layered timeout policy through the custom Rust boundary', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}' })
    const request: ProviderRequest = {
      endpoint: 'https://provider.example/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'test', messages: [] },
    }
    await requestProviderRequest({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      request,
      timeoutPolicy: { connectTimeoutMs: 1_000, firstByteTimeoutMs: 2_000, totalTimeoutMs: 5_000 },
    })
    expect(invoke).toHaveBeenCalledWith('request_custom_llm', expect.objectContaining({
      request: expect.objectContaining({
        timeoutPolicy: { connectTimeoutMs: 1_000, firstByteTimeoutMs: 2_000, totalTimeoutMs: 5_000 },
      }),
    }))
  })

  it('normalizes an already complete endpoint without duplicating the path', () => {
    expect(buildChatCompletionsEndpoint('https://provider.example/v1/chat/completions/'))
      .toBe('https://provider.example/v1/chat/completions')
    expect(usesCustomProvider('https://provider.example/v1')).toBe(true)
  })

  it('converts Rust proxy transport failures to retryable timeout errors', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('自定义供应商请求超时'))

    await expect(requestProviderChatCompletion({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      payload: { model: 'test', messages: [] },
    })).rejects.toMatchObject({ name: 'HttpRequestError', isTimeout: true })
  })

  it('classifies Rust proxy DNS failures as retryable transport errors', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('无法解析自定义供应商域名: DNS lookup failed'))

    await expect(requestProviderChatCompletion({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      payload: { model: 'test', messages: [] },
    })).rejects.toMatchObject({ name: 'HttpRequestError', isTimeout: false, isRetryable: true })
  })


  it('reuses caller requestId and traceId across the Tauri command, response and errors', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: '{"choices":[{"message":{"content":"ok"}}]}',
      requestId: 'request-trace-1',
      traceId: 'trace-operation-1',
    })

    const response = await requestProviderChatCompletion({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      payload: { model: 'test', messages: [] },
      requestId: 'request-trace-1',
      traceId: 'trace-operation-1',
    })

    expect(response.requestId).toBe('request-trace-1')
    expect(response.traceId).toBe('trace-operation-1')
    expect(invoke).toHaveBeenCalledWith('request_custom_llm', expect.objectContaining({
      request: expect.objectContaining({ requestId: 'request-trace-1', traceId: 'trace-operation-1' }),
    }))

    vi.mocked(invoke).mockRejectedValue(new Error('[custom-llm requestId=request-trace-1 traceId=trace-operation-1] 自定义供应商请求超时（阶段：first_byte）'))
    await expect(requestProviderChatCompletion({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      payload: { model: 'test', messages: [] },
      requestId: 'request-trace-1',
      traceId: 'trace-operation-1',
    })).rejects.toMatchObject({
      name: 'HttpRequestError',
      requestId: 'request-trace-1',
      traceId: 'trace-operation-1',
      isTimeout: true,
      timeoutPhase: 'first_byte',
    })
  })})

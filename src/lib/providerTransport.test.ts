import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  buildChatCompletionsEndpoint,
  requestProviderChatCompletion,
  usesCustomProvider,
} from './providerTransport'

describe('provider transport', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('keeps built-in providers on the Tauri HTTP path', async () => {
    await expect(requestProviderChatCompletion({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      payload: { model: 'gpt-4o', messages: [] },
    })).resolves.toMatchObject({ ok: true })

    expect(invoke).not.toHaveBeenCalled()
  })

  it('routes arbitrary HTTPS providers through the Rust command', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}' })

    const response = await requestProviderChatCompletion({
      baseUrl: 'https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp',
      apiKey: 'test-key',
      payload: { model: 'qwen-plus', messages: [] },
    })

    expect(response.ok).toBe(true)
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] })
    expect(invoke).toHaveBeenCalledWith('request_custom_llm', expect.objectContaining({
      request: expect.objectContaining({
        url: 'https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp/chat/completions',
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

})

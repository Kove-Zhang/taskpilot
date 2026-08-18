import { describe, expect, it } from 'vitest'
import { ClassifiedLLMError } from '../errors'
import { getProviderAdapter, hasProviderAdapter } from '../adapterRegistry'
import { buildOpenAIChatEndpoint, OpenAIChatAdapter } from './openaiChat'
import { createProviderProfileFromLegacy } from '../providerProfiles'
import { getTaskProfile } from '../taskProfiles'
import type { ProviderResponse } from '../types'

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    ...createProviderProfileFromLegacy({
      id: 'primary',
      name: '测试服务商',
      apiBaseUrl: 'https://api.example.test/v1',
      modelName: 'test-model',
      enabled: true,
      priority: 1,
    }),
    ...overrides,
  }
}

function createResponse(data: unknown, status = 200, headers?: Headers): ProviderResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(data),
    json: async () => data,
  }
}

describe('OpenAIChatAdapter', () => {
  it('builds a chat endpoint without duplicating the suffix', () => {
    expect(buildOpenAIChatEndpoint('https://api.example.test/v1/')).toBe('https://api.example.test/v1/chat/completions')
    expect(buildOpenAIChatEndpoint('https://api.example.test/v1/chat/completions')).toBe('https://api.example.test/v1/chat/completions')
  })

  it('builds authenticated requests with trusted instructions and task limits', () => {
    const adapter = new OpenAIChatAdapter()
    const request = adapter.buildRequest({
      provider: createProvider({ maxOutputTokens: 4_000 }),
      apiKey: '  test-secret  ',
      task: getTaskProfile('todo-extraction'),
      envelope: {
        trustedInstructions: ['规则一', '规则二'],
        messages: [{ role: 'user', content: '请提取待办' }],
      },
    })

    expect(request.endpoint).toBe('https://api.example.test/v1/chat/completions')
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret',
    })
    expect(request.body).toMatchObject({
      model: 'test-model',
      max_tokens: 2_000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '规则一\n\n规则二' },
        { role: 'user', content: '请提取待办' },
      ],
    })
  })

  it('uses strict JSON Schema only when the provider declares support', () => {
    const adapter = new OpenAIChatAdapter()
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    }
    const request = adapter.buildRequest({
      provider: createProvider({
        capabilities: {
          vision: false,
          structuredOutput: 'json_schema',
          reasoning: true,
          streaming: false,
          verified: true,
        },
        requestOverrides: { temperature: 0.4 },
      }),
      task: { ...getTaskProfile('todo-extraction'), reasoning: 'high' },
      envelope: {
        trustedInstructions: [],
        messages: [{ role: 'user', content: '内容' }],
      },
      schema,
    })

    expect(request.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'task_pilot_output',
        strict: true,
        schema,
      },
    })
    expect(request.body.reasoning_effort).toBe('high')
    expect(request.body.temperature).toBe(0.4)
  })

  it('normalizes string content, usage, finish reason and response id', async () => {
    const result = await new OpenAIChatAdapter().parseResponse(createResponse({
      id: 'response-1',
      choices: [{
        message: { content: '  完成结果  ' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        reasoning_tokens: 2,
      },
    }))

    expect(result).toEqual({
      text: '完成结果',
      usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 2 },
      finishReason: 'stop',
      responseId: 'response-1',
      rawMetadata: { providerProtocol: 'openai-chat' },
    })
  })

  it('normalizes array text content from compatible providers', async () => {
    const result = await new OpenAIChatAdapter('custom-compatible').parseResponse(createResponse({
      choices: [{
        message: {
          content: [
            { type: 'text', text: '第一段' },
            { type: 'text', text: '第二段' },
          ],
        },
      }],
    }))

    expect(result.text).toBe('第一段第二段')
    expect(result.rawMetadata).toEqual({ providerProtocol: 'custom-compatible' })
  })

  it('classifies HTTP failures for retry and failover decisions', async () => {
    await expect(new OpenAIChatAdapter().parseResponse(createResponse({ error: {} }, 429)))
      .rejects.toMatchObject({
        errorClass: 'rate_limited',
        retryable: true,
        failoverable: true,
        userActionRequired: false,
        status: 429,
      })

    await expect(new OpenAIChatAdapter().parseResponse(createResponse({ error: {} }, 401)))
      .rejects.toMatchObject({
        errorClass: 'auth',
        retryable: false,
        failoverable: false,
        userActionRequired: true,
        status: 401,
      })
  })

  it('classifies malformed success responses as invalid_response', async () => {
    await expect(new OpenAIChatAdapter().parseResponse(createResponse({ choices: [] })))
      .rejects.toBeInstanceOf(ClassifiedLLMError)
    await expect(new OpenAIChatAdapter().parseResponse(createResponse({ choices: [] })))
      .rejects.toMatchObject({
        errorClass: 'invalid_response',
        retryable: false,
        failoverable: false,
      })
  })
})

describe('adapter registry', () => {
  it('registers OpenAI Chat and custom-compatible protocols', () => {
    expect(hasProviderAdapter('openai-chat')).toBe(true)
    expect(hasProviderAdapter('custom-compatible')).toBe(true)
    expect(getProviderAdapter('openai-chat')).toBeInstanceOf(OpenAIChatAdapter)
    expect(getProviderAdapter('custom-compatible').protocol).toBe('custom-compatible')
  })

  it('rejects unsupported protocols instead of silently falling back', () => {
    expect(() => getProviderAdapter('anthropic-messages')).toThrowError(
      expect.objectContaining({
        errorClass: 'invalid_request',
        userActionRequired: true,
      }),
    )
  })
  it('preserves Retry-After metadata on rate-limit errors', async () => {
    const adapter = new OpenAIChatAdapter()

    await expect(adapter.parseResponse(createResponse({ error: 'rate limited' }, 429, new Headers({ 'retry-after': '3' }))))
      .rejects.toMatchObject({
        errorClass: 'rate_limited',
        retryAfterMs: 3_000,
      })
  })

})




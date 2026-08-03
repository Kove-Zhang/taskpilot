import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callAIWithFailover, extractTodosFromContent, generateWriting } from './ai'
import { useSettingsStore, type LLMProvider } from '../store'
import { fetch } from '@tauri-apps/plugin-http'
import { invoke } from '@tauri-apps/api/core'

const providers: LLMProvider[] = [
  { id: 'first', name: 'First', apiBaseUrl: 'https://first.example/v1', apiKey: 'first-key', modelName: 'gpt-4o', enabled: true, priority: 1 },
  { id: 'second', name: 'Second', apiBaseUrl: 'https://second.example/v1', apiKey: 'second-key', modelName: 'gpt-4o-mini', enabled: true, priority: 2 },
]

describe('AI Helper Methods', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset()
    vi.mocked(invoke).mockReset()
    useSettingsStore.setState({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelName: 'gpt-4o',
      personalFocus: 'Test focus',
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
      llmProviders: [],
      enableFailover: true,
      failoverRetryCount: 1,
      failoverOnAuthError: false,
      notionProperties: [],
      fieldMappings: {},
      tokenLimit: 8000,
      enableReasoning: false,
    })
  })

  it('throws if no API key is configured', async () => {
    useSettingsStore.setState({ apiKey: '', llmProviders: [] })
    await expect(generateWriting('Write email', [])).rejects.toThrow('请先在设置中配置 API Key')
  })

  it('sends the current todo context and returns completion content', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'This is the generated text.' } }] }),
    } as Response)

    const todos = [{ id: '1', title: 'test', priority: 'High', type: 'bug', planned_date: null }]
    const result = await generateWriting('Draft an email', todos)

    expect(result).toBe('This is the generated text.')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const payload = JSON.parse(String(init?.body))
    expect(payload).toHaveProperty('model', 'gpt-4o')
    expect(payload.messages[1].content[0].text).toContain('Draft an email')
    expect(payload.messages[1].content[0].text).toContain('title:test')
  })

  it('does not retry or fail over on a non-retryable 400 response', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 3 })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'request_custom_llm') return { status: 400, body: 'invalid request' }
      return undefined
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'test',
    )).rejects.toThrow('(400)')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(1)
    expect(vi.mocked(invoke).mock.calls.find(([command]) => command === 'request_custom_llm')?.[0]).toBe('request_custom_llm')
    expect(vi.mocked(invoke).mock.calls.find(([command]) => command === 'request_custom_llm')?.[1]).toMatchObject({
      request: { url: 'https://first.example/v1/chat/completions' },
    })
  })

  it('fails over to the next provider after a retryable transport error', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1 })
    let customRequestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      customRequestCount += 1
      if (customRequestCount === 1) throw new TypeError('network connection reset')
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'failover-test',
    )).resolves.toBe('fallback answer')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(2)
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm').map(([, args]) => (args as { request: { url: string } }).request.url)).toEqual([
      'https://first.example/v1/chat/completions',
      'https://second.example/v1/chat/completions',
    ])
  })

  it('does not retry malformed successful responses or forward them to another provider', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 3 })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'request_custom_llm') {
        return { status: 200, body: JSON.stringify({ choices: [{}] }) }
      }
      return undefined
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'invalid-schema-test',
    )).rejects.toThrow('缺少有效 message.content')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(1)
  })

  it('rotates on a retryable 429 response after the current provider attempt', async () => {
    useSettingsStore.setState({ llmProviders: [...providers].reverse(), enableFailover: true, failoverRetryCount: 1 })
    let requestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      requestCount += 1
      if (requestCount === 1) return { status: 429, body: 'rate limited' }
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: '429 fallback answer' } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      '429-failover-test',
    )).resolves.toBe('429 fallback answer')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm').map(([, args]) => (
      args as { request: { url: string } }
    ).request.url)).toEqual([
      'https://first.example/v1/chat/completions',
      'https://second.example/v1/chat/completions',
    ])
  })

  it('does not rotate when failover is disabled after a retryable failure', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: false, failoverRetryCount: 1 })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'request_custom_llm') return { status: 503, body: 'unavailable' }
      return undefined
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'failover-disabled-test',
    )).rejects.toThrow('(503)')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(1)
  })


  it('rotates on a retryable 5xx response', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1 })
    let requestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      requestCount += 1
      if (requestCount === 1) return { status: 503, body: 'service unavailable' }
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: '5xx fallback answer' } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      '5xx-failover-test',
    )).resolves.toBe('5xx fallback answer')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(2)
  })


  it.each([409, 425])('rotates on retryable HTTP status %i', async (status) => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1 })
    let requestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      requestCount += 1
      if (requestCount === 1) return { status, body: `retryable status ${status}` }
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: `${status} fallback answer` } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      `${status}-failover-test`,
    )).resolves.toBe(`${status} fallback answer`)

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(2)
  })

  it('rotates when a provider returns an invalid JSON success response', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1 })
    let requestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      requestCount += 1
      if (requestCount === 1) return { status: 200, body: '{invalid-json' }
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: 'json fallback answer' } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'invalid-json-failover-test',
    )).resolves.toBe('json fallback answer')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(2)
  })

  it('rotates after a retryable custom-provider DNS resolution failure', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1 })
    let requestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      requestCount += 1
      if (requestCount === 1) throw new Error('无法解析自定义供应商域名: DNS lookup failed')
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: 'dns fallback answer' } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'dns-failover-test',
    )).resolves.toBe('dns fallback answer')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(2)
  })


  it('does not rotate on a 401 authentication failure by default', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1, failoverOnAuthError: false })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'request_custom_llm') return { status: 401, body: 'invalid api key' }
      return undefined
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      '401-default-test',
    )).rejects.toThrow('(401)')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm')).toHaveLength(1)
  })

  it('rotates directly to the next provider when 401 fallback is enabled', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 3, failoverOnAuthError: true })
    let requestCount = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'request_custom_llm') return undefined
      requestCount += 1
      if (requestCount === 1) return { status: 401, body: 'invalid api key' }
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: 'authenticated fallback answer' } }] }),
      }
    })

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      '401-enabled-test',
    )).resolves.toBe('authenticated fallback answer')

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_custom_llm').map(([, args]) => (
      args as { request: { url: string } }
    ).request.url)).toEqual([
      'https://first.example/v1/chat/completions',
      'https://second.example/v1/chat/completions',
    ])
  })


  it('fails over after Tauri HTTP reports an error sending the request', async () => {
    const builtinProviders: LLMProvider[] = [
      { id: 'tower', name: 'AI中台', apiBaseUrl: 'https://ai.chinatowercom.cn:30080/v1', apiKey: 'tower-key', modelName: 'qwen3.7-plus', enabled: true, priority: 1 },
      { id: 'openai', name: 'Fallback', apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'fallback-key', modelName: 'gpt-4o-mini', enabled: true, priority: 2 },
    ]
    useSettingsStore.setState({ llmProviders: builtinProviders, enableFailover: true, failoverRetryCount: 1 })
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('error sending request for url (https://ai.chinatowercom.cn:30080/v1/chat/completions)'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'fallback after request-send error' } }] }),
      } as Response)

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'request-send-failover-test',
    )).resolves.toBe('fallback after request-send error')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://ai.chinatowercom.cn:30080/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ])
  })

  it('keeps required title in the prompt and normalizes a configured Notion title field', async () => {
    useSettingsStore.setState({
      notionProperties: [
        { id: 'notion-title', name: '事项名称', type: 'title' },
        { id: 'notion-owner', name: '负责人', type: 'rich_text' },
      ],
      fieldMappings: {
        'notion-title': { notionPropId: 'notion-title', enabled: true, aiHint: '', order: 1 },
        'notion-owner': { notionPropId: 'notion-owner', enabled: true, aiHint: '', order: 2 },
      },
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '需要完成报告。',
              todos: [{ '事项名称': '整理并提交周报', '负责人': '张三', priority: 'High', planned_date: null }],
            }),
          },
        }],
      }),
    } as Response)

    const result = await extractTodosFromContent('请在本周内整理并提交周报。', [])

    expect(result.todos).toHaveLength(1)
    expect(result.todos[0]).toMatchObject({
      title: '整理并提交周报',
      '事项名称': '整理并提交周报',
      selected: true,
    })
    expect(result.todos[0].id).toMatch(/^generated-1-/)

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const payload = JSON.parse(String(init?.body))
    const systemPrompt = payload.messages[0].content as string
    expect(systemPrompt).toContain('"title": "待办事项标题（非空字符串）"')
    expect(systemPrompt).toContain('"事项名称": "字符串"')
    expect(systemPrompt).toContain('每一项都必须同时包含字面量字段 "id" 和 "title"')
  })

})

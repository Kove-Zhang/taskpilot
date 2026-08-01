import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callAIWithFailover, generateWriting } from './ai'
import { useSettingsStore, type LLMProvider } from '../store'
import { fetch } from '@tauri-apps/plugin-http'

const providers: LLMProvider[] = [
  { id: 'first', name: 'First', apiBaseUrl: 'https://first.example/v1', apiKey: 'first-key', modelName: 'gpt-4o', enabled: true, priority: 1 },
  { id: 'second', name: 'Second', apiBaseUrl: 'https://second.example/v1', apiKey: 'second-key', modelName: 'gpt-4o-mini', enabled: true, priority: 2 },
]

describe('AI Helper Methods', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset()
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
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid request' } as Response)

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'test',
    )).rejects.toThrow('(400)')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://first.example/v1/chat/completions')
  })

  it('fails over to the next provider after a retryable transport error', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 1 })
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('network connection reset'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'fallback answer' } }] }),
      } as Response)

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'failover-test',
    )).resolves.toBe('fallback answer')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://first.example/v1/chat/completions',
      'https://second.example/v1/chat/completions',
    ])
  })

  it('does not retry malformed successful responses or forward them to another provider', async () => {
    useSettingsStore.setState({ llmProviders: providers, enableFailover: true, failoverRetryCount: 3 })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{}] }),
    } as Response)

    await expect(callAIWithFailover(
      (provider) => ({ model: provider.modelName, messages: [{ role: 'user', content: 'test' }] }),
      'invalid-schema-test',
    )).rejects.toThrow('缺少有效 message.content')

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

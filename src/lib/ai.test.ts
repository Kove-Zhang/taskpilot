import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateWriting } from './ai'
import { useSettingsStore } from '../store'

describe('AI Helper Methods', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelName: 'gpt-4o',
      personalFocus: 'Test focus',
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
    })
  })

  it('generateWriting should throw if no API key', async () => {
    useSettingsStore.setState({ apiKey: '' })
    await expect(generateWriting('Write email', [])).rejects.toThrow('请先在设置中配置 API Key')
  })

  it('generateWriting should call fetch and return content', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: 'This is the generated text.' } }
        ]
      })
    })
    // Mock the global fetch from @tauri-apps/plugin-http
    vi.mocked(await import('@tauri-apps/plugin-http')).fetch = mockFetch

    const todos = [{ id: '1', title: 'Buy milk', priority: '★', type: 'Life' }]
    const result = await generateWriting('Draft an email', todos)

    expect(result).toBe('This is the generated text.')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs[0]).toBe('https://api.openai.com/v1/chat/completions')
    expect(JSON.parse(callArgs[1].body)).toHaveProperty('model', 'gpt-4o')
    expect(JSON.parse(callArgs[1].body).messages[1].content[0].text).toContain('Draft an email')
    expect(JSON.parse(callArgs[1].body).messages[1].content[0].text).toContain('Buy milk')
  })
})

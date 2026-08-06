import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import { useSettingsStore } from '../store'
import { backgroundReviewAndUpdateFocus } from './autoOptimize'
import type { TodoItem } from './ai'

const todo = (id: string, title: string): TodoItem => ({
  id,
  title,
  priority: 'Medium',
  planned_date: null,
})

describe('automatic positive feedback evolution', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset()
    vi.restoreAllMocks()
  })

  it('skips the model call when the user did not change the selected result', async () => {
    useSettingsStore.setState({
      promptMode: 'auto',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelName: 'gpt-4o-mini',
      autoOptimizedFocus: '当前规则',
      llmProviders: [],
    })

    await expect(backgroundReviewAndUpdateFocus([todo('a', 'A')], [todo('a', 'A')]))
      .resolves.toBe('skipped')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports unchanged positive feedback after analyzing a changed selection', async () => {
    useSettingsStore.setState({
      promptMode: 'auto',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelName: 'gpt-4o-mini',
      autoOptimizedFocus: '当前规则',
      llmProviders: [],
      enableFailover: true,
      failoverRetryCount: 1,
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '当前规则' } }] }),
    } as Response)
    const eventPromise = new Promise<CustomEvent>((resolve) => {
      window.addEventListener('ai-evolution-completed', (event) => resolve(event as CustomEvent), { once: true })
    })

    await expect(backgroundReviewAndUpdateFocus(
      [todo('a', 'A'), todo('b', 'B')],
      [todo('a', 'A')],
    )).resolves.toBe('unchanged')

    const event = await eventPromise
    expect(event.detail).toMatchObject({ status: 'unchanged', title: '✅ 正反馈已记录' })
  })
})

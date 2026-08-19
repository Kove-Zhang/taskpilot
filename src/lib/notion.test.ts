import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import { markNotionSyncVerified, syncToNotion } from './notion'
import { useSettingsStore } from '../store'

let sequence = 0
const makeTodo = (overrides: Record<string, unknown> = {}) => ({
  id: `notion-test-todo-${++sequence}`,
  title: 'Prepare report',
  priority: 'High',
  planned_date: null,
  status: 'Todo',
  ...overrides,
})

function setDefaultSchema() {
  useSettingsStore.setState({
    notionApiKey: 'notion-test-key',
    notionDatabaseId: 'database-id',
    notionProperties: [
      { id: 'title', name: 'title', type: 'title' },
      { id: 'status', name: 'status', type: 'status', options: ['Todo'] },
    ],
    fieldMappings: {
      title: { notionPropId: 'title', enabled: true, aiHint: '', order: 0 },
      status: { notionPropId: 'status', enabled: false, aiHint: '', order: 1 },
    },
  })
}

describe('Notion sync', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset()
    setDefaultSchema()
  })

  it('sends only enabled mapped fields and skips an acknowledged duplicate', async () => {
    const todo = makeTodo()
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: 'notion-page-1' }) } as Response)

    const first = await syncToNotion([todo])
    const second = await syncToNotion([todo])

    expect(first).toEqual([{ id: todo.id, success: true, pageId: 'notion-page-1' }])
    expect(second).toEqual([{ id: todo.id, success: true, pageId: 'notion-page-1', skipped: true }])
    expect(fetch).toHaveBeenCalledTimes(1)

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect(body.properties).toHaveProperty('title')
    expect(body.properties).not.toHaveProperty('status')
  })

  it('allows an explicitly confirmed manual resync after a successful result', async () => {
    const todo = makeTodo()
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'notion-page-original' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'notion-page-resynced' }) } as Response)

    const first = await syncToNotion([todo])
    const manual = await syncToNotion([todo], { manualResync: true })

    expect(first).toEqual([{ id: todo.id, success: true, pageId: 'notion-page-original' }])
    expect(manual).toEqual([{ id: todo.id, success: true, pageId: 'notion-page-resynced' }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('returns a visible error for enabled but unsupported mapped properties', async () => {
    useSettingsStore.setState({
      notionProperties: [{ id: 'formula', name: 'formula', type: 'formula' }],
      fieldMappings: { formula: { notionPropId: 'formula', enabled: true, aiHint: '', order: 0 } },
    })

    const result = await syncToNotion([makeTodo({ formula: 'value' })])

    expect(result[0].success).toBe(false)
    expect(result[0].error).toContain('暂不支持同步')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serializes status and relation fields using validated schema options', async () => {
    useSettingsStore.setState({
      notionProperties: [
        { id: 'title', name: 'title', type: 'title' },
        { id: 'status', name: 'status', type: 'status', options: ['In progress'] },
        { id: 'relation', name: 'relation', type: 'relation' },
      ],
      fieldMappings: {
        title: { notionPropId: 'title', enabled: true, aiHint: '', order: 0 },
        status: { notionPropId: 'status', enabled: true, aiHint: '', order: 1 },
        relation: { notionPropId: 'relation', enabled: true, aiHint: '', order: 2 },
      },
    })
    const todo = makeTodo({ status: 'In progress', relation: 'page-a, page-b' })
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: 'notion-page-status' }) } as Response)

    const result = await syncToNotion([todo])

    expect(result[0]).toMatchObject({ id: todo.id, success: true, pageId: 'notion-page-status' })
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect(body.properties.status).toEqual({ status: { name: 'In progress' } })
    expect(body.properties.relation).toEqual({ relation: [{ id: 'page-a' }, { id: 'page-b' }] })
  })

  it('marks retryable server failures as unknown and blocks automatic duplicate creation', async () => {
    const todo = makeTodo()
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable',
    } as Response)

    const first = await syncToNotion([todo])
    expect(first[0]).toMatchObject({ id: todo.id, success: false })
    expect(first[0].error).toContain('(503)')

    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: 'should-not-be-created' }) } as Response)
    const second = await syncToNotion([todo])

    expect(second[0]).toMatchObject({ success: false, retryable: false, needsVerification: true })
    expect(second[0].error).toContain('上次同步结果未知')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows an explicitly confirmed force retry after an unknown result', async () => {
    const todo = makeTodo()
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable',
    } as Response)

    const first = await syncToNotion([todo])
    expect(first[0]).toMatchObject({ needsVerification: true })

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'notion-page-retried' }) } as Response)
    const forced = await syncToNotion([todo], { forceTodoIds: [todo.id] })

    expect(forced).toEqual([{ id: todo.id, success: true, pageId: 'notion-page-retried' }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('can mark a manually verified existing page as synchronized without another POST', async () => {
    const todo = makeTodo()

    await markNotionSyncVerified(todo, 'existing-page-id')
    const result = await syncToNotion([todo])

    expect(result).toEqual([{ id: todo.id, success: true, pageId: 'existing-page-id', skipped: true }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects values that are not present in an enabled status schema', async () => {
    useSettingsStore.setState({
      fieldMappings: {
        title: { notionPropId: 'title', enabled: true, aiHint: '', order: 0 },
        status: { notionPropId: 'status', enabled: true, aiHint: '', order: 1 },
      },
    })
    const result = await syncToNotion([makeTodo({ status: 'Unknown' })])

    expect(result[0].success).toBe(false)
    expect(result[0].error).toContain('不包含选项')
    expect(fetch).not.toHaveBeenCalled()
  })
})

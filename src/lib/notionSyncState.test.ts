import { describe, expect, it } from 'vitest'
import {
  createNotionSyncFailureState,
  getNotionSyncButtonLabel,
  resolveNotionSyncTodos,
  summarizeNotionSyncResults,
} from './notionSyncState'

describe('Notion sync state', () => {
  it('summarizes a fully successful batch', () => {
    const state = summarizeNotionSyncResults([
      { id: 'a', success: true },
      { id: 'b', success: true },
    ], 2, '2026-08-04T00:00:00.000Z')

    expect(state).toMatchObject({
      status: 'success',
      total: 2,
      succeededCount: 2,
      failedCount: 0,
      failedTodoIds: [],
      uncertainTodoIds: [],
      lastAttemptAt: '2026-08-04T00:00:00.000Z',
    })
    expect(getNotionSyncButtonLabel(state)).toBe('已同步')
  })

  it('summarizes a fully failed batch and exposes a retry label', () => {
    const state = summarizeNotionSyncResults([
      { id: 'a', success: false, error: '403' },
      { id: 'b', success: false, error: '403' },
    ], 2)

    expect(state.status).toBe('failed')
    expect(state.failedTodoIds).toEqual(['a', 'b'])
    expect(getNotionSyncButtonLabel(state)).toBe('同步失败 · 重试')
  })

  it('summarizes mixed success and definite failure with a count', () => {
    const state = summarizeNotionSyncResults([
      { id: 'a', success: true },
      { id: 'b', success: false, error: '400' },
      { id: 'c', success: false, error: '400' },
    ], 3)

    expect(state).toMatchObject({ status: 'partial_failed', succeededCount: 1, failedCount: 2 })
    expect(getNotionSyncButtonLabel(state)).toBe('部分失败 · 重试 2 项')
  })

  it('prioritizes verification when a batch contains an uncertain result', () => {
    const state = summarizeNotionSyncResults([
      { id: 'a', success: true },
      { id: 'b', success: false, needsVerification: true, error: 'timeout' },
    ], 2)

    expect(state.status).toBe('needs_verification')
    expect(state.uncertainTodoIds).toEqual(['b'])
    expect(getNotionSyncButtonLabel(state)).toBe('待核验')
  })

  it('resolves manually verified todo IDs while retaining other failures', () => {
    const state = summarizeNotionSyncResults([
      { id: 'a', success: true },
      { id: 'b', success: false, needsVerification: true, error: 'timeout' },
      { id: 'c', success: false, error: '400' },
    ], 3)
    const resolved = resolveNotionSyncTodos(state, ['b'], '2026-08-04T00:01:00.000Z')

    expect(resolved).toMatchObject({
      status: 'partial_failed',
      succeededCount: 2,
      failedCount: 1,
      failedTodoIds: ['c'],
      uncertainTodoIds: [],
      lastAttemptAt: '2026-08-04T00:01:00.000Z',
    })
  })

  it('creates a failed state when the transport fails before results are returned', () => {
    const state = createNotionSyncFailureState(2, ['a', 'b'], '配置缺失')

    expect(state).toMatchObject({
      status: 'failed',
      total: 2,
      succeededCount: 0,
      failedCount: 2,
      lastError: '配置缺失',
    })
  })

  it('keeps legacy successful history labels compatible', () => {
    expect(getNotionSyncButtonLabel(undefined, false, true)).toBe('已同步')
  })
})

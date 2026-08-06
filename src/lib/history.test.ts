import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { updateHistory } from './history'

const result = { summary: 'summary', todos: [] }

describe('history repository', () => {
  let persisted: unknown[]

  beforeEach(() => {
    persisted = []
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'load_history') return JSON.stringify(persisted)
      if (command === 'save_history') {
        persisted = JSON.parse(String((args as { data: string }).data))
      }
      return undefined as never
    })
  })

  it('serializes concurrent read-modify-write updates', async () => {
    await Promise.all([
      updateHistory((history) => [...history, { timestamp: '2026-08-01T00:00:00.000Z', result }]),
      updateHistory((history) => [...history, { timestamp: '2026-08-01T00:00:01.000Z', result }]),
    ])

    expect(persisted).toHaveLength(2)
  })

  it('continues processing queued updates after a persistence failure', async () => {
    let saveAttempts = 0
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'load_history') return JSON.stringify(persisted)
      if (command === 'save_history') {
        saveAttempts += 1
        if (saveAttempts === 1) throw new Error('disk temporarily unavailable')
        persisted = JSON.parse(String((args as { data: string }).data))
      }
      return undefined as never
    })

    await expect(updateHistory((history) => [...history, { timestamp: '2026-08-01T00:00:00.000Z', result }]))
      .rejects.toThrow('disk temporarily unavailable')
    await expect(updateHistory((history) => [...history, { timestamp: '2026-08-01T00:01:00.000Z', result }]))
      .resolves.toHaveLength(1)

    expect(persisted).toHaveLength(1)
  })
})

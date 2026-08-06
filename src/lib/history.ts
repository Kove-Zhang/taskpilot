import { invoke } from '@tauri-apps/api/core'
import type { AIResult } from './ai'

export interface HistoryEntry {
  timestamp: string
  result: AIResult
  input?: string
  images?: string[]
}

let writeQueue: Promise<void> = Promise.resolve()

function cloneHistory(history: HistoryEntry[]): HistoryEntry[] {
  return structuredClone(history)
}

function parseHistory(data: string): HistoryEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(data || '[]')
  } catch {
    throw new Error('历史记录文件格式损坏，无法解析。')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('历史记录文件格式无效，期望为数组。')
  }

  return parsed as HistoryEntry[]
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const data = await invoke<string>('load_history')
  return parseHistory(data)
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

export async function updateHistory(
  updater: (current: HistoryEntry[]) => HistoryEntry[],
): Promise<HistoryEntry[]> {
  return enqueueWrite(async () => {
    const current = await loadHistory()
    const next = updater(cloneHistory(current))
    await invoke('save_history', { data: JSON.stringify(next) })
    return cloneHistory(next)
  })
}

export async function replaceHistory(history: HistoryEntry[]): Promise<HistoryEntry[]> {
  return updateHistory(() => history)
}

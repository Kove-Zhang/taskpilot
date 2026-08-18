import type { AIResult, PositiveFeedbackStatus, TodoItem } from './ai'
import type { AutoOptimizeOutcome } from './autoOptimize'

export interface PositiveFeedbackSnapshot {
  originalTodos: TodoItem[]
  acceptedTodos: TodoItem[]
  fingerprint: string
  changed: boolean
}

export interface PositiveFeedbackState {
  positiveFeedbackStatus?: PositiveFeedbackStatus
  positiveFeedbackFingerprint?: string
  positiveFeedbackUpdatedAt?: number
  positiveFeedbackError?: string
}

function normalizeTodo(todo: TodoItem): Record<string, unknown> {
  const normalized = { ...todo }
  delete normalized.selected
  delete normalized.synced
  return normalized
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableNormalize(item)]),
    )
  }
  return value
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableNormalize(value))
}

function hashString(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

function cloneForLearning(todos: TodoItem[]): TodoItem[] {
  return todos.map(normalizeTodo) as TodoItem[]
}

export function createPositiveFeedbackSnapshot(
  originalTodos: TodoItem[],
  currentTodos: TodoItem[],
): PositiveFeedbackSnapshot {
  const normalizedOriginal = cloneForLearning(originalTodos)
  const normalizedAccepted = cloneForLearning(
    currentTodos.filter((todo) => todo.selected !== false),
  )
  const originalSerialized = stableSerialize(normalizedOriginal)
  const acceptedSerialized = stableSerialize(normalizedAccepted)

  return {
    originalTodos: structuredClone(normalizedOriginal),
    acceptedTodos: structuredClone(normalizedAccepted),
    fingerprint: `positive-v1-${hashString(`${originalSerialized}\u0000${acceptedSerialized}`)}`,
    changed: originalSerialized !== acceptedSerialized,
  }
}

export function shouldStartPositiveFeedbackLearning(
  current: Pick<AIResult, 'positiveFeedbackStatus' | 'positiveFeedbackFingerprint'>,
  snapshot: PositiveFeedbackSnapshot,
): boolean {
  if (!snapshot.changed) return false
  if (current.positiveFeedbackFingerprint !== snapshot.fingerprint) return true
  return !['processing', 'completed', 'unchanged'].includes(current.positiveFeedbackStatus || '')
}


export async function runPositiveFeedbackLearning(snapshot: PositiveFeedbackSnapshot): Promise<AutoOptimizeOutcome> {
  const { backgroundReviewAndUpdateFocus } = await import('./autoOptimize')
  return backgroundReviewAndUpdateFocus(snapshot.originalTodos, snapshot.acceptedTodos)
}

import { describe, expect, it } from 'vitest'
import type { TodoItem } from './ai'
import {
  createPositiveFeedbackSnapshot,
  shouldStartPositiveFeedbackLearning,
} from './feedbackLearning'

const todo = (id: string, title: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  id,
  title,
  priority: 'Medium',
  planned_date: null,
  selected: true,
  ...extra,
})

describe('positive feedback learning snapshots', () => {
  it('keeps all selected todos for learning even when some are already synced', () => {
    const original = [todo('a', 'A'), todo('b', 'B'), todo('c', 'C')]
    const current = [
      todo('a', 'A', { synced: true }),
      todo('b', 'B', { synced: true }),
      todo('c', 'C'),
    ]

    const snapshot = createPositiveFeedbackSnapshot(original, current)

    expect(snapshot.acceptedTodos.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(snapshot.acceptedTodos.every(item => !('synced' in item))).toBe(true)
    expect(snapshot.changed).toBe(false)
  })

  it('recognizes a user deselection as a positive feedback change', () => {
    const snapshot = createPositiveFeedbackSnapshot(
      [todo('a', 'A'), todo('b', 'B')],
      [todo('a', 'A'), todo('b', 'B', { selected: false })],
    )

    expect(snapshot.acceptedTodos.map(item => item.id)).toEqual(['a'])
    expect(snapshot.changed).toBe(true)
    expect(snapshot.fingerprint).toMatch(/^positive-v1-/)
  })

  it('does not duplicate completed or in-flight learning for the same fingerprint', () => {
    const snapshot = createPositiveFeedbackSnapshot(
      [todo('a', 'A'), todo('b', 'B')],
      [todo('a', 'A')],
    )

    expect(shouldStartPositiveFeedbackLearning({}, snapshot)).toBe(true)
    expect(shouldStartPositiveFeedbackLearning({
      positiveFeedbackFingerprint: snapshot.fingerprint,
      positiveFeedbackStatus: 'processing',
    }, snapshot)).toBe(false)
    expect(shouldStartPositiveFeedbackLearning({
      positiveFeedbackFingerprint: snapshot.fingerprint,
      positiveFeedbackStatus: 'completed',
    }, snapshot)).toBe(false)
    expect(shouldStartPositiveFeedbackLearning({
      positiveFeedbackFingerprint: snapshot.fingerprint,
      positiveFeedbackStatus: 'failed',
    }, snapshot)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ClassifiedLLMError,
  isClassifiedLLMError,
  isFailoverableLLMErrorClass,
  isTransientLLMErrorClass,
  isUserActionRequiredLLMErrorClass,
} from './errors'
import { getTaskProfile, isLLMTaskType } from './taskProfiles'

describe('LLM foundation contracts', () => {
  it('provides task-specific defaults without sharing mutable objects', () => {
    const first = getTaskProfile('todo-extraction')
    const second = getTaskProfile('todo-extraction')

    expect(first.needsStructuredOutput).toBe(true)
    expect(first.allowRepair).toBe(true)
    expect(first).not.toBe(second)

    first.maxInputChars = 1
    expect(second.maxInputChars).toBe(8_000)
  })

  it('allocates enough budget for full focus-rule revisions', () => {
    expect(getTaskProfile('prompt-optimization')).toMatchObject({
      maxInputChars: 12_000,
      maxOutputTokens: 3_000,
    })
    expect(getTaskProfile('history-learning').maxOutputTokens).toBe(3_000)
  })

  it('recognizes only supported task types', () => {
    expect(isLLMTaskType('writing')).toBe(true)
    expect(isLLMTaskType('not-a-task')).toBe(false)
  })

  it('exposes consistent default error actions', () => {
    expect(isTransientLLMErrorClass('rate_limited')).toBe(true)
    expect(isFailoverableLLMErrorClass('capability_mismatch')).toBe(true)
    expect(isUserActionRequiredLLMErrorClass('auth')).toBe(true)

    const error = new ClassifiedLLMError('auth', 'API Key 无效')
    expect(isClassifiedLLMError(error)).toBe(true)
    expect(error.retryable).toBe(false)
    expect(error.failoverable).toBe(false)
    expect(error.userActionRequired).toBe(true)
  })
})

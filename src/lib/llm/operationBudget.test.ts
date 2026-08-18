import { describe, expect, it } from 'vitest'
import { OperationBudget, OperationBudgetExhaustedError } from './operationBudget'

describe('operation budget', () => {
  it('limits LLM attempts, provider switches and email attempts independently', () => {
    const budget = new OperationBudget({
      operationId: 'operation-test',
      deadlineAt: 10_000,
      maxLLMAttempts: 2,
      maxProviderSwitches: 1,
      maxEmailAttempts: 1,
      now: () => 0,
    })

    expect(budget.consumeLLMAttempt().usedLLMAttempts).toBe(1)
    expect(budget.consumeLLMAttempt().usedLLMAttempts).toBe(2)
    expect(() => budget.consumeLLMAttempt()).toThrowError(OperationBudgetExhaustedError)
    expect(budget.consumeProviderSwitch().usedProviderSwitches).toBe(1)
    expect(() => budget.consumeProviderSwitch()).toThrowError(OperationBudgetExhaustedError)
    expect(budget.consumeEmailAttempt().usedEmailAttempts).toBe(1)
    expect(() => budget.consumeEmailAttempt()).toThrowError(OperationBudgetExhaustedError)
  })

  it('stops all operation kinds after the deadline', () => {
    let now = 100
    const budget = new OperationBudget({ operationId: 'deadline-test', deadlineAt: 200, now: () => now })
    expect(budget.consumeLLMAttempt().usedLLMAttempts).toBe(1)
    now = 200
    expect(() => budget.consumeProviderSwitch()).toThrowError(OperationBudgetExhaustedError)
    expect(budget.getSnapshot()).toMatchObject({ operationId: 'deadline-test', exhaustedReason: 'deadline' })
  })
})

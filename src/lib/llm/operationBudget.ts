export type OperationBudgetKind = 'llm_attempt' | 'provider_switch' | 'email_attempt'
export type OperationBudgetExhaustedReason = 'deadline' | 'llm_attempts' | 'provider_switches' | 'email_attempts'

export interface OperationBudgetOptions {
  operationId?: string
  deadlineAt?: number
  deadlineMs?: number
  maxLLMAttempts?: number
  maxProviderSwitches?: number
  maxEmailAttempts?: number
  now?: () => number
}

export interface OperationBudgetSnapshot {
  operationId: string
  startedAt: number
  deadlineAt: number
  maxLLMAttempts: number
  maxProviderSwitches: number
  maxEmailAttempts: number
  usedLLMAttempts: number
  usedProviderSwitches: number
  usedEmailAttempts: number
  exhaustedReason?: OperationBudgetExhaustedReason
}

export const DEFAULT_OPERATION_BUDGET = {
  deadlineMs: 10 * 60_000,
  maxLLMAttempts: 4,
  maxProviderSwitches: 2,
  maxEmailAttempts: 3,
} as const

export class OperationBudgetExhaustedError extends Error {
  readonly reason: OperationBudgetExhaustedReason
  readonly operationId: string
  readonly snapshot: OperationBudgetSnapshot

  constructor(reason: OperationBudgetExhaustedReason, snapshot: OperationBudgetSnapshot) {
    super(`操作预算已耗尽：${reason}`)
    this.name = 'OperationBudgetExhaustedError'
    this.reason = reason
    this.operationId = snapshot.operationId
    this.snapshot = snapshot
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.max(0, Math.floor(value))
}

export class OperationBudget {
  readonly operationId: string
  readonly startedAt: number
  readonly deadlineAt: number
  readonly maxLLMAttempts: number
  readonly maxProviderSwitches: number
  readonly maxEmailAttempts: number

  private readonly now: () => number
  private usedLLMAttempts = 0
  private usedProviderSwitches = 0
  private usedEmailAttempts = 0
  private exhaustedReason: OperationBudgetExhaustedReason | undefined

  constructor(options: OperationBudgetOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.startedAt = this.now()
    this.operationId = options.operationId ?? `operation-${this.startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    this.deadlineAt = options.deadlineAt ?? this.startedAt + Math.max(1, options.deadlineMs ?? DEFAULT_OPERATION_BUDGET.deadlineMs)
    this.maxLLMAttempts = normalizeLimit(options.maxLLMAttempts, DEFAULT_OPERATION_BUDGET.maxLLMAttempts)
    this.maxProviderSwitches = normalizeLimit(options.maxProviderSwitches, DEFAULT_OPERATION_BUDGET.maxProviderSwitches)
    this.maxEmailAttempts = normalizeLimit(options.maxEmailAttempts, DEFAULT_OPERATION_BUDGET.maxEmailAttempts)
  }

  getSnapshot(): OperationBudgetSnapshot {
    return {
      operationId: this.operationId,
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      maxLLMAttempts: this.maxLLMAttempts,
      maxProviderSwitches: this.maxProviderSwitches,
      maxEmailAttempts: this.maxEmailAttempts,
      usedLLMAttempts: this.usedLLMAttempts,
      usedProviderSwitches: this.usedProviderSwitches,
      usedEmailAttempts: this.usedEmailAttempts,
      ...(this.exhaustedReason ? { exhaustedReason: this.exhaustedReason } : {}),
    }
  }

  isExpired(): boolean {
    return this.now() >= this.deadlineAt
  }

  consumeLLMAttempt(): OperationBudgetSnapshot {
    return this.consume('llm_attempt')
  }

  consumeProviderSwitch(): OperationBudgetSnapshot {
    return this.consume('provider_switch')
  }

  consumeEmailAttempt(): OperationBudgetSnapshot {
    return this.consume('email_attempt')
  }

  private consume(kind: OperationBudgetKind): OperationBudgetSnapshot {
    const reason = this.getExhaustedReason(kind)
    if (reason) {
      this.exhaustedReason = reason
      const snapshot = this.getSnapshot()
      throw new OperationBudgetExhaustedError(reason, snapshot)
    }

    if (kind === 'llm_attempt') this.usedLLMAttempts += 1
    if (kind === 'provider_switch') this.usedProviderSwitches += 1
    if (kind === 'email_attempt') this.usedEmailAttempts += 1
    return this.getSnapshot()
  }

  private getExhaustedReason(kind: OperationBudgetKind): OperationBudgetExhaustedReason | undefined {
    if (this.isExpired()) return 'deadline'
    if (kind === 'llm_attempt' && this.usedLLMAttempts >= this.maxLLMAttempts) return 'llm_attempts'
    if (kind === 'provider_switch' && this.usedProviderSwitches >= this.maxProviderSwitches) return 'provider_switches'
    if (kind === 'email_attempt' && this.usedEmailAttempts >= this.maxEmailAttempts) return 'email_attempts'
    return undefined
  }
}

export function createOperationBudget(options: OperationBudgetOptions = {}): OperationBudget {
  return new OperationBudget(options)
}

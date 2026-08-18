import type { ProviderProfile, CompletionUsage } from './types'
import { getProviderInstanceKey, providerHealthRegistry } from './providerHealth'
import type { ProviderHealthRegistry, ProviderHealthSnapshot } from './providerHealth'
import type { UsageCostEstimate } from './usageCost'

export type LLMRouteDecision = 'selected' | 'skipped' | 'cooled-down' | 'capability-mismatch'
export type LLMCallEventStatus = 'success' | 'failure' | 'skipped'

export function createLLMId(prefix: string): string {
  const randomUuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `${prefix}-${randomUuid}`
}

export interface RedactedLLMCallEvent {
  traceId: string
  requestId: string
  taskType: string
  providerId: string
  providerName: string
  model: string
  /** Full provider instance identity when emitted by the runtime. */
  providerInstanceKey?: string
  operationId?: string
  budget?: {
    usedLLMAttempts: number
    usedProviderSwitches: number
    usedEmailAttempts: number
    exhaustedReason?: string
  }
  attempt: number
  routeDecision: LLMRouteDecision
  eventStatus: LLMCallEventStatus
  startedAt: number
  durationMs: number
  status?: number
  errorClass?: string
  retryAfterMs?: number
  fallbackFrom?: string
  inputChars?: number
  estimatedInputTokens?: number
  usage?: CompletionUsage
  estimatedCost?: number
  costCurrency?: string
  costStatus?: UsageCostEstimate['status']
  costUnknownReasons?: string[]
  imageCount?: number
  imageBytes?: number
  finishReason?: string
  truncated?: boolean
}

export type ProviderHealthStatus = 'available' | 'cooling' | 'half_open' | 'unknown'

export interface ProviderHealthSummary {
  instanceKey: string
  providerId: string
  providerName: string
  model: string
  status: ProviderHealthStatus
  capabilities: ProviderProfile['capabilities']
  eventCount: number
  attempts: number
  successes: number
  failures: number
  successRate?: number
  p50LatencyMs?: number
  p95LatencyMs?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastErrorClass?: string
  cooldownUntil?: number
  retryAfterCount: number
  knownCostCalls: number
  unknownCostCalls: number
  totalEstimatedCost?: number
  currency?: string
}

export interface LLMEventStoreOptions {
  maxEvents?: number
  healthRegistry: Pick<ProviderHealthRegistry, 'getSnapshotForProfile'>
}

function cloneUsage(usage: CompletionUsage | undefined): CompletionUsage | undefined {
  return usage ? { ...usage } : undefined
}

function clampNonNegativeInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value < 0) return undefined
  return Math.floor(value)
}

function sanitizeEvent(event: RedactedLLMCallEvent): RedactedLLMCallEvent {
  const sanitized: RedactedLLMCallEvent = {
    traceId: String(event.traceId).slice(0, 120),
    requestId: String(event.requestId).slice(0, 120),
    taskType: String(event.taskType).slice(0, 80),
    providerId: String(event.providerId).slice(0, 120),
    providerName: String(event.providerName).slice(0, 160),
    model: String(event.model).slice(0, 160),
    ...(event.providerInstanceKey ? { providerInstanceKey: String(event.providerInstanceKey).slice(0, 120) } : {}),
    attempt: clampNonNegativeInteger(event.attempt) ?? 0,
    routeDecision: event.routeDecision,
    eventStatus: event.eventStatus,
    startedAt: Number.isFinite(event.startedAt) ? event.startedAt : Date.now(),
    durationMs: clampNonNegativeInteger(event.durationMs) ?? 0,
  }
  if (event.operationId) sanitized.operationId = event.operationId.slice(0, 120)
  if (event.budget) {
    sanitized.budget = {
      usedLLMAttempts: clampNonNegativeInteger(event.budget.usedLLMAttempts) ?? 0,
      usedProviderSwitches: clampNonNegativeInteger(event.budget.usedProviderSwitches) ?? 0,
      usedEmailAttempts: clampNonNegativeInteger(event.budget.usedEmailAttempts) ?? 0,
      ...(event.budget.exhaustedReason ? { exhaustedReason: event.budget.exhaustedReason.slice(0, 80) } : {}),
    }
  }
  if (event.status !== undefined) sanitized.status = clampNonNegativeInteger(event.status)
  if (event.errorClass) sanitized.errorClass = event.errorClass.slice(0, 80)
  if (event.retryAfterMs !== undefined) sanitized.retryAfterMs = clampNonNegativeInteger(event.retryAfterMs)
  if (event.fallbackFrom) sanitized.fallbackFrom = event.fallbackFrom.slice(0, 120)
  if (event.inputChars !== undefined) sanitized.inputChars = clampNonNegativeInteger(event.inputChars)
  if (event.estimatedInputTokens !== undefined) sanitized.estimatedInputTokens = clampNonNegativeInteger(event.estimatedInputTokens)
  if (event.usage) sanitized.usage = cloneUsage(event.usage)
  if (event.estimatedCost !== undefined && Number.isFinite(event.estimatedCost)) sanitized.estimatedCost = event.estimatedCost
  if (event.costCurrency) sanitized.costCurrency = event.costCurrency.slice(0, 20)
  if (event.costStatus) sanitized.costStatus = event.costStatus
  if (event.costUnknownReasons) sanitized.costUnknownReasons = event.costUnknownReasons.map((reason) => String(reason).slice(0, 80)).slice(0, 10)
  if (event.imageCount !== undefined) sanitized.imageCount = clampNonNegativeInteger(event.imageCount)
  if (event.imageBytes !== undefined) sanitized.imageBytes = clampNonNegativeInteger(event.imageBytes)
  if (event.finishReason) sanitized.finishReason = event.finishReason.slice(0, 80)
  if (event.truncated === true) sanitized.truncated = true
  return sanitized
}

function percentile(values: number[], ratio: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function mapHealthStatus(snapshot: ProviderHealthSnapshot): ProviderHealthStatus {
  if (snapshot.state === 'open') return 'cooling'
  if (snapshot.state === 'half_open') return 'half_open'
  return 'available'
}

/** In-memory bounded event store; event payloads never contain prompt or secret fields. */
export class LLMEventStore {
  private readonly maxEvents: number
  private readonly healthRegistry: Pick<ProviderHealthRegistry, 'getSnapshotForProfile'>
  private events: RedactedLLMCallEvent[] = []
  private readonly listeners = new Set<() => void>()

  constructor(options: LLMEventStoreOptions) {
    this.maxEvents = Math.max(100, Math.floor(options.maxEvents ?? 500))
    this.healthRegistry = options.healthRegistry
  }

  record(event: RedactedLLMCallEvent): RedactedLLMCallEvent {
    const sanitized = sanitizeEvent(event)
    this.events = [...this.events, sanitized].slice(-this.maxEvents)
    this.listeners.forEach((listener) => listener())
    return { ...sanitized, usage: cloneUsage(sanitized.usage) }
  }

  getEvents(): RedactedLLMCallEvent[] {
    return this.events.map((event) => ({ ...event, usage: cloneUsage(event.usage) }))
  }

  clear(): void {
    this.events = []
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getProviderSummaries(profiles: readonly ProviderProfile[]): ProviderHealthSummary[] {
    return profiles.map((profile) => {
      const instanceKey = getProviderInstanceKey(profile)
      const providerEvents = this.events.filter((event) => event.providerInstanceKey
        ? event.providerInstanceKey === instanceKey
        : event.providerId === profile.id && event.model === profile.model)
      const requestEvents = providerEvents.filter((event) => event.routeDecision === 'selected')
      const successes = requestEvents.filter((event) => event.eventStatus === 'success')
      const failures = requestEvents.filter((event) => event.eventStatus === 'failure')
      const latencies = successes.map((event) => event.durationMs).filter((value) => value >= 0)
      const knownCostEvents = successes.filter((event) => event.costStatus === 'known' && event.estimatedCost !== undefined)
      const totalEstimatedCost = knownCostEvents.length > 0
        ? Math.round(knownCostEvents.reduce((total, event) => total + (event.estimatedCost ?? 0), 0) * 100_000_000) / 100_000_000
        : undefined
      const lastSuccess = successes.at(-1)
      const lastFailure = failures.at(-1)
      const snapshot = this.healthRegistry.getSnapshotForProfile(profile)
      const attempts = successes.length + failures.length

      return {
        instanceKey,
        providerId: profile.id,
        providerName: profile.name,
        model: profile.model,
        status: mapHealthStatus(snapshot),
        capabilities: { ...profile.capabilities },
        eventCount: providerEvents.length,
        attempts,
        successes: successes.length,
        failures: failures.length,
        successRate: attempts > 0 ? Math.round((successes.length / attempts) * 10_000) / 100 : undefined,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        lastSuccessAt: lastSuccess?.startedAt,
        lastFailureAt: lastFailure?.startedAt,
        lastErrorClass: lastFailure?.errorClass,
        cooldownUntil: snapshot.cooldownUntil,
        retryAfterCount: failures.filter((event) => event.retryAfterMs !== undefined).length,
        knownCostCalls: knownCostEvents.length,
        unknownCostCalls: successes.filter((event) => event.costStatus === 'unknown').length,
        totalEstimatedCost,
        currency: knownCostEvents.find((event) => event.costCurrency)?.costCurrency,
      }
    })
  }
}

export const llmEventStore = new LLMEventStore({ healthRegistry: providerHealthRegistry, maxEvents: 500 })

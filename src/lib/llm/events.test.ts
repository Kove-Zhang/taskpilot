import { describe, expect, it } from 'vitest'
import { LLMEventStore } from './events'
import { getProviderInstanceKey, ProviderHealthRegistry } from './providerHealth'
import type { ProviderProfile } from './types'

const profile: ProviderProfile = {
  id: 'primary',
  name: 'Primary',
  apiProtocol: 'openai-chat',
  baseUrl: 'https://provider.example/v1',
  model: 'test-model',
  enabled: true,
  priority: 1,
  apiKeyRef: 'provider:primary',
  capabilities: { vision: true, structuredOutput: 'json_schema', reasoning: true, streaming: false, verified: true },
  timeoutPolicy: { connectTimeoutMs: 10, firstByteTimeoutMs: 20, totalTimeoutMs: 30 },
  retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20 },
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    traceId: 'trace-1',
    requestId: 'request-1',
    taskType: 'writing',
    providerId: 'primary',
    providerName: 'Primary',
    model: 'test-model',
    attempt: 1,
    routeDecision: 'selected' as const,
    eventStatus: 'success' as const,
    startedAt: Date.now(),
    durationMs: 10,
    ...overrides,
  }
}

describe('LLM event store', () => {
  it('keeps a bounded redacted event list and notifies subscribers', () => {
    const registry = new ProviderHealthRegistry()
    const store = new LLMEventStore({ maxEvents: 100, healthRegistry: registry })
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })

    store.record(event({ prompt: 'must not be stored', apiKey: 'secret', usage: { inputTokens: 2 } }))
    unsubscribe()
    store.record(event({ requestId: 'request-2' }))

    const events = store.getEvents()
    expect(events).toHaveLength(2)
    expect(events[0]).not.toHaveProperty('prompt')
    expect(events[0]).not.toHaveProperty('apiKey')
    expect(events[0].usage).toEqual({ inputTokens: 2 })
    expect(notifications).toBe(1)
  })

  it('retains only the newest events after reaching the configured cap', () => {
    const registry = new ProviderHealthRegistry()
    const store = new LLMEventStore({ maxEvents: 100, healthRegistry: registry })
    for (let index = 0; index < 101; index += 1) {
      store.record(event({ requestId: `request-${index}` }))
    }

    expect(store.getEvents()).toHaveLength(100)
    expect(store.getEvents()[0].requestId).toBe('request-1')
    expect(store.getEvents().at(-1)?.requestId).toBe('request-100')
  })

  it('aggregates success rate, percentiles, retry-after, cost and health state', () => {
    let now = 1_000
    const registry = new ProviderHealthRegistry({ now: () => now })
    const store = new LLMEventStore({ maxEvents: 100, healthRegistry: registry })
    store.record(event({ requestId: 'success-1', startedAt: 1_000, durationMs: 10, estimatedCost: 0.1, costStatus: 'known', costCurrency: 'USD' }))
    store.record(event({ requestId: 'success-2', startedAt: 2_000, durationMs: 50, estimatedCost: 0.2, costStatus: 'known', costCurrency: 'USD' }))
    store.record(event({
      requestId: 'failure-1',
      eventStatus: 'failure',
      startedAt: 3_000,
      durationMs: 20,
      errorClass: 'rate_limited',
      retryAfterMs: 2_000,
    }))
    registry.recordFailureProfile(profile, { retryAfterMs: 2_000 })
    now = 2_000

    const summary = store.getProviderSummaries([profile])[0]
    expect(summary).toMatchObject({
      status: 'cooling',
      attempts: 3,
      successes: 2,
      failures: 1,
      successRate: 66.67,
      p50LatencyMs: 10,
      p95LatencyMs: 50,
      retryAfterCount: 1,
      knownCostCalls: 2,
      totalEstimatedCost: 0.3,
      currency: 'USD',
      lastErrorClass: 'rate_limited',
    })
  })

  it('isolates event aggregates by provider and model and exposes unique instance keys', () => {
    const registry = new ProviderHealthRegistry()
    const store = new LLMEventStore({ maxEvents: 100, healthRegistry: registry })
    const modelB: ProviderProfile = { ...profile, model: 'second-model' }

    store.record(event({ requestId: 'model-a-success', durationMs: 10, estimatedCost: 0.1, costStatus: 'known', costCurrency: 'USD' }))
    store.record(event({ requestId: 'model-b-failure', model: 'second-model', eventStatus: 'failure', errorClass: 'rate_limited', durationMs: 90, retryAfterMs: 5000 }))

    const summaries = store.getProviderSummaries([profile, modelB])
    expect(summaries[0]).toMatchObject({ attempts: 1, successes: 1, failures: 0, totalEstimatedCost: 0.1, retryAfterCount: 0 })
    expect(summaries[1]).toMatchObject({ attempts: 1, successes: 0, failures: 1, totalEstimatedCost: undefined, retryAfterCount: 1, lastErrorClass: 'rate_limited' })
    expect(summaries[0].instanceKey).not.toBe(summaries[1].instanceKey)
  })
  it('keeps same Provider ID and model isolated after an endpoint or protocol instance change', () => {
    const registry = new ProviderHealthRegistry()
    const store = new LLMEventStore({ maxEvents: 100, healthRegistry: registry })
    const movedEndpoint: ProviderProfile = { ...profile, baseUrl: 'https://provider-two.example/v1' }

    store.record(event({ requestId: 'old-endpoint', durationMs: 12, providerInstanceKey: getProviderInstanceKey(profile) }))
    store.record(event({ requestId: 'new-endpoint', durationMs: 88, providerInstanceKey: getProviderInstanceKey(movedEndpoint) }))

    const [oldSummary, newSummary] = store.getProviderSummaries([profile, movedEndpoint])
    expect(oldSummary).toMatchObject({ attempts: 1, p95LatencyMs: 12 })
    expect(newSummary).toMatchObject({ attempts: 1, p95LatencyMs: 88 })
    expect(oldSummary.instanceKey).not.toBe(newSummary.instanceKey)
  })})

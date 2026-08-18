import { describe, expect, it } from 'vitest'
import { ProviderHealthRegistry } from './providerHealth'
import { LLMEventStore } from './events'
import type { ProviderProfile } from './types'

describe('provider health circuit', () => {
  it('opens after a transient failure, skips during cooldown, and allows one half-open probe', () => {
    let now = 1_000
    const registry = new ProviderHealthRegistry({ now: () => now, cooldownBaseMs: 10_000, cooldownMaxMs: 30_000 })

    expect(registry.acquire('primary')).toMatchObject({ allowed: true, state: 'closed' })
    const failure = registry.recordFailure('primary')
    expect(registry.getSnapshot('primary')).toMatchObject({ state: 'open', consecutiveFailures: 1 })
    expect(failure).toMatchObject({ state: 'open', consecutiveFailures: 1, cooldownUntil: 11_000 })
    expect(registry.acquire('primary')).toMatchObject({ allowed: false, state: 'open', retryAt: 11_000 })

    now = 11_000
    expect(registry.acquire('primary')).toMatchObject({ allowed: true, state: 'half_open' })
    expect(registry.acquire('primary')).toMatchObject({ allowed: false, state: 'half_open' })

    expect(registry.recordSuccess('primary')).toMatchObject({ state: 'closed', consecutiveFailures: 0, halfOpenInFlight: false })
    expect(registry.getSnapshot('primary')).toMatchObject({ state: 'closed', consecutiveFailures: 0 })
    expect(registry.acquire('primary')).toMatchObject({ allowed: true, state: 'closed' })
  })

  it('honors a server retry delay even when it exceeds the local cooldown cap', () => {
    const registry = new ProviderHealthRegistry({ cooldownBaseMs: 1_000, cooldownMaxMs: 2_000, now: () => 0 })
    const snapshot = registry.recordFailure('rate-limited', { retryAfterMs: 60_000 })
    expect(snapshot.cooldownUntil).toBe(60_000)
  })

  it('maps closed, open and half-open snapshots to the settings health statuses', () => {
    let now = 0
    const registry = new ProviderHealthRegistry({ now: () => now, cooldownBaseMs: 100, cooldownMaxMs: 100 })
    const store = new LLMEventStore({ healthRegistry: registry })
    const profile: ProviderProfile = {
      id: 'mapped', name: 'Mapped', apiProtocol: 'openai-chat', baseUrl: 'https://example.test/v1', model: 'model', enabled: true, priority: 1,
      apiKeyRef: 'provider:mapped', capabilities: { vision: false, structuredOutput: 'none', reasoning: false, streaming: false, verified: false },
      timeoutPolicy: { connectTimeoutMs: 1, firstByteTimeoutMs: 1, totalTimeoutMs: 1 }, retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }

    expect(store.getProviderSummaries([profile])[0].status).toBe('available')
    registry.recordFailureProfile(profile)
    expect(store.getProviderSummaries([profile])[0].status).toBe('cooling')
    now = 100
    expect(registry.acquireProfile(profile)).toMatchObject({ allowed: true, state: 'half_open' })
    expect(store.getProviderSummaries([profile])[0].status).toBe('half_open')
  })


  it('keeps health circuits isolated per provider model and does not use legacy fallback', () => {
    let now = 0
    const registry = new ProviderHealthRegistry({ now: () => now, cooldownBaseMs: 100, cooldownMaxMs: 100 })

    registry.recordFailure('shared', {}, 'model-a')
    expect(registry.getSnapshot('shared', 'model-a')).toMatchObject({ state: 'open', model: 'model-a' })
    expect(registry.getSnapshot('shared', 'model-b')).toMatchObject({ state: 'closed', model: 'model-b' })

    registry.recordFailure('shared')
    expect(registry.getSnapshot('shared', 'model-b')).toMatchObject({ state: 'closed', model: 'model-b' })
    expect(registry.getSnapshot('shared')).toMatchObject({ state: 'open' })

    now = 100
    expect(registry.acquire('shared', 'model-a')).toMatchObject({ allowed: true, state: 'half_open' })
    expect(registry.acquire('shared', 'model-b')).toMatchObject({ allowed: true, state: 'closed' })
  })
  it('keeps circuit state isolated when a provider endpoint changes without changing its ID or model', () => {
    const registry = new ProviderHealthRegistry({ cooldownBaseMs: 100, cooldownMaxMs: 100 })
    const oldInstance: ProviderProfile = {
      id: 'same', name: 'Same', apiProtocol: 'openai-chat', baseUrl: 'https://old.example/v1', model: 'same-model', enabled: true, priority: 1,
      apiKeyRef: 'provider:same', capabilities: { vision: false, structuredOutput: 'none', reasoning: false, streaming: false },
      timeoutPolicy: { connectTimeoutMs: 100, firstByteTimeoutMs: 100, totalTimeoutMs: 100 }, retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    }
    const movedInstance = { ...oldInstance, baseUrl: 'https://new.example/v1' }

    registry.recordFailureProfile(oldInstance)
    expect(registry.getSnapshotForProfile(oldInstance).state).toBe('open')
    expect(registry.getSnapshotForProfile(movedInstance).state).toBe('closed')
    expect(registry.acquireProfile(movedInstance)).toMatchObject({ allowed: true, state: 'closed' })
  })})

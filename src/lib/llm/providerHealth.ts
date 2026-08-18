export type ProviderCircuitState = 'closed' | 'open' | 'half_open'

import type { ProviderProfile } from './types'

export type ProviderHealthProfile = Pick<ProviderProfile, 'id' | 'apiProtocol' | 'baseUrl' | 'model'>

/**
 * Returns a stable, non-sensitive identity for one configured provider instance.
 * The identity deliberately hashes the provider id, protocol, normalized endpoint,
 * and model so UI keys and runtime records cannot expose URL credentials/query data.
 */
export function getProviderInstanceKey(profile: ProviderHealthProfile): string {
  const normalizedBaseUrl = normalizeProviderBaseUrl(profile.baseUrl)
  const input = [profile.id, profile.apiProtocol, normalizedBaseUrl, profile.model].join('\u0000')
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return 'provider-instance-' + (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeProviderBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim())
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.protocol.toLowerCase() + '//' + url.hostname.toLowerCase() + (url.port ? ':' + url.port : '') + pathname
  } catch {
    return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  }
}

export interface ProviderHealthSnapshot {
  providerId: string
  model?: string
  /** Present for profile-scoped runtime records. */
  instanceKey?: string
  state: ProviderCircuitState
  consecutiveFailures: number
  openedAt?: number
  cooldownUntil?: number
  lastFailureAt?: number
  lastSuccessAt?: number
  halfOpenInFlight: boolean
}

export interface ProviderFailureOptions {
  nowMs?: number
  retryAfterMs?: number
  cooldownBaseMs?: number
  cooldownMaxMs?: number
}

export interface ProviderHealthRegistryOptions {
  now?: () => number
  cooldownBaseMs?: number
  cooldownMaxMs?: number
}

interface MutableProviderHealth {
  consecutiveFailures: number
  state: ProviderCircuitState
  openedAt?: number
  cooldownUntil?: number
  lastFailureAt?: number
  lastSuccessAt?: number
  halfOpenInFlight: boolean
}

export interface ProviderAcquireResult {
  allowed: boolean
  state: ProviderCircuitState
  retryAt?: number
}

/**
 * In-memory circuit state. Secrets and payloads never enter this registry.
 * Legacy ID/model methods remain available for compatibility; current runtime
 * paths must use the profile-scoped methods to prevent endpoint changes from
 * inheriting a previous instance's health state.
 */
export class ProviderHealthRegistry {
  private readonly records = new Map<string, MutableProviderHealth>()
  private readonly now: () => number
  private readonly cooldownBaseMs: number
  private readonly cooldownMaxMs: number

  constructor(options: ProviderHealthRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.cooldownBaseMs = Math.max(1, options.cooldownBaseMs ?? 10_000)
    this.cooldownMaxMs = Math.max(this.cooldownBaseMs, options.cooldownMaxMs ?? 5 * 60_000)
  }

  private static legacyKey(providerId: string, model?: string): string {
    return `${providerId}\u0000${model ?? ''}`
  }

  private getOrCreate(key: string): MutableProviderHealth {
    const existing = this.records.get(key)
    if (existing) return existing
    const created: MutableProviderHealth = { consecutiveFailures: 0, state: 'closed', halfOpenInFlight: false }
    this.records.set(key, created)
    return created
  }

  private acquireRecord(record: MutableProviderHealth, effectiveNow: number): ProviderAcquireResult {
    if (record.state === 'closed') return { allowed: true, state: 'closed' }
    if (record.state === 'open') {
      if ((record.cooldownUntil ?? 0) > effectiveNow) return { allowed: false, state: 'open', retryAt: record.cooldownUntil }
      if (record.halfOpenInFlight) return { allowed: false, state: 'half_open' }
      record.state = 'half_open'
      record.halfOpenInFlight = true
      return { allowed: true, state: 'half_open' }
    }
    if (record.halfOpenInFlight) return { allowed: false, state: 'half_open' }
    record.halfOpenInFlight = true
    return { allowed: true, state: 'half_open' }
  }

  private markSuccess(record: MutableProviderHealth, nowMs: number): void {
    record.consecutiveFailures = 0
    record.state = 'closed'
    record.openedAt = undefined
    record.cooldownUntil = undefined
    record.halfOpenInFlight = false
    record.lastSuccessAt = nowMs
  }

  private markFailure(record: MutableProviderHealth, options: ProviderFailureOptions): void {
    const nowMs = options.nowMs ?? this.now()
    const base = Math.max(1, options.cooldownBaseMs ?? this.cooldownBaseMs)
    const max = Math.max(base, options.cooldownMaxMs ?? this.cooldownMaxMs)
    record.consecutiveFailures += 1
    const exponential = Math.min(max, base * (2 ** Math.max(0, record.consecutiveFailures - 1)))
    const cooldownMs = Math.max(exponential, options.retryAfterMs ?? 0)
    record.state = 'open'
    record.openedAt = nowMs
    record.cooldownUntil = nowMs + cooldownMs
    record.lastFailureAt = nowMs
    record.halfOpenInFlight = false
  }

  private snapshot(providerId: string, model: string | undefined, key: string, instanceKey?: string): ProviderHealthSnapshot {
    const record = this.getOrCreate(key)
    return {
      providerId,
      ...(model !== undefined ? { model } : {}),
      ...(instanceKey ? { instanceKey } : {}),
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      openedAt: record.openedAt,
      cooldownUntil: record.cooldownUntil,
      lastFailureAt: record.lastFailureAt,
      lastSuccessAt: record.lastSuccessAt,
      halfOpenInFlight: record.halfOpenInFlight,
    }
  }

  acquire(providerId: string, modelOrNow?: string | number, nowMs: number = this.now()): ProviderAcquireResult {
    const model = typeof modelOrNow === 'string' ? modelOrNow : undefined
    const effectiveNow = typeof modelOrNow === 'number' ? modelOrNow : nowMs
    return this.acquireRecord(this.getOrCreate(ProviderHealthRegistry.legacyKey(providerId, model)), effectiveNow)
  }

  recordSuccess(providerId: string, modelOrNow?: string | number, nowMs: number = this.now()): ProviderHealthSnapshot {
    const model = typeof modelOrNow === 'string' ? modelOrNow : undefined
    const effectiveNow = typeof modelOrNow === 'number' ? modelOrNow : nowMs
    const key = ProviderHealthRegistry.legacyKey(providerId, model)
    this.markSuccess(this.getOrCreate(key), effectiveNow)
    return this.snapshot(providerId, model, key)
  }

  recordFailure(providerId: string, options: ProviderFailureOptions = {}, model?: string): ProviderHealthSnapshot {
    const key = ProviderHealthRegistry.legacyKey(providerId, model)
    this.markFailure(this.getOrCreate(key), options)
    return this.snapshot(providerId, model, key)
  }

  getSnapshot(providerId: string, model?: string): ProviderHealthSnapshot {
    return this.snapshot(providerId, model, ProviderHealthRegistry.legacyKey(providerId, model))
  }

  acquireProfile(profile: ProviderHealthProfile, nowMs: number = this.now()): ProviderAcquireResult {
    return this.acquireRecord(this.getOrCreate(getProviderInstanceKey(profile)), nowMs)
  }

  recordSuccessProfile(profile: ProviderHealthProfile, nowMs: number = this.now()): ProviderHealthSnapshot {
    const instanceKey = getProviderInstanceKey(profile)
    this.markSuccess(this.getOrCreate(instanceKey), nowMs)
    return this.snapshot(profile.id, profile.model, instanceKey, instanceKey)
  }

  recordFailureProfile(profile: ProviderHealthProfile, options: ProviderFailureOptions = {}): ProviderHealthSnapshot {
    const instanceKey = getProviderInstanceKey(profile)
    this.markFailure(this.getOrCreate(instanceKey), options)
    return this.snapshot(profile.id, profile.model, instanceKey, instanceKey)
  }

  getSnapshotForProfile(profile: ProviderHealthProfile): ProviderHealthSnapshot {
    const instanceKey = getProviderInstanceKey(profile)
    return this.snapshot(profile.id, profile.model, instanceKey, instanceKey)
  }

  reset(providerId?: string, model?: string): void {
    if (!providerId) { this.records.clear(); return }
    if (model !== undefined) { this.records.delete(ProviderHealthRegistry.legacyKey(providerId, model)); return }
    for (const key of this.records.keys()) if (key.startsWith(`${providerId}\u0000`)) this.records.delete(key)
  }

  resetProfile(profile: ProviderHealthProfile): void {
    this.records.delete(getProviderInstanceKey(profile))
  }
}

export const providerHealthRegistry = new ProviderHealthRegistry()

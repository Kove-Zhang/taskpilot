import { hasProviderAdapter } from './adapterRegistry'
import type { ApiProtocol, CostProfile, ProviderCapabilities, ProviderProfile, RetryPolicy, TimeoutPolicy } from './types'

export interface LegacyProviderConfig {
  id: string
  name: string
  apiBaseUrl: string
  modelName: string
  enabled: boolean
  priority: number
}

export const DEFAULT_PROVIDER_TIMEOUT_POLICY: TimeoutPolicy = {
  connectTimeoutMs: 60_000,
  firstByteTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
}

export const DEFAULT_PROVIDER_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
}

/**
 * Legacy providers are treated as OpenAI-compatible during migration. The
 * capability values preserve current behavior, while verified=false makes the
 * compatibility assumption visible to the future router and settings UI.
 */
export const DEFAULT_LEGACY_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  vision: true,
  structuredOutput: 'json_object',
  reasoning: false,
  streaming: false,
  verified: false,
}

export function createProviderProfileFromLegacy(
  provider: LegacyProviderConfig,
  existingProfile?: ProviderProfile,
): ProviderProfile {
  if (existingProfile) {
    const safeExistingProfile = sanitizeProviderProfile(existingProfile)
    const targetIdentityChanged = safeExistingProfile.baseUrl !== provider.apiBaseUrl.trim()
      || safeExistingProfile.model !== provider.modelName.trim()
    return {
      ...safeExistingProfile,
      id: provider.id,
      name: provider.name,
      baseUrl: provider.apiBaseUrl,
      model: provider.modelName,
      enabled: provider.enabled,
      priority: provider.priority,
      apiKeyRef: safeExistingProfile.apiKeyRef || `provider:${provider.id}`,
      apiProtocol: safeExistingProfile.apiProtocol || 'openai-chat',
      capabilities: {
        ...DEFAULT_LEGACY_PROVIDER_CAPABILITIES,
        ...safeExistingProfile.capabilities,
        verified: !targetIdentityChanged && safeExistingProfile.capabilities?.verified === true,
      },
      timeoutPolicy: { ...DEFAULT_PROVIDER_TIMEOUT_POLICY, ...safeExistingProfile.timeoutPolicy },
      retryPolicy: { ...DEFAULT_PROVIDER_RETRY_POLICY, ...safeExistingProfile.retryPolicy },
    }
  }

  return {
    id: provider.id,
    name: provider.name,
    apiProtocol: 'openai-chat',
    baseUrl: provider.apiBaseUrl,
    model: provider.modelName,
    enabled: provider.enabled,
    priority: provider.priority,
    apiKeyRef: `provider:${provider.id}`,
    capabilities: { ...DEFAULT_LEGACY_PROVIDER_CAPABILITIES },
    timeoutPolicy: { ...DEFAULT_PROVIDER_TIMEOUT_POLICY },
    retryPolicy: { ...DEFAULT_PROVIDER_RETRY_POLICY },
  }
}

export function createProviderProfilesFromLegacy(
  providers: readonly LegacyProviderConfig[],
  existingProfiles: readonly ProviderProfile[] = [],
): ProviderProfile[] {
  const profilesById = new Map(existingProfiles.map((profile) => {
    const safeProfile = sanitizeProviderProfile(profile)
    return [safeProfile.id, safeProfile] as const
  }))
  return providers.map((provider) => createProviderProfileFromLegacy(provider, profilesById.get(provider.id)))
}


export interface ProviderProfileValidationResult {
  valid: boolean
  errors: string[]
}

export class ProviderProfileValidationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`服务商配置无效：${errors.join('；')}`)
    this.name = 'ProviderProfileValidationError'
    this.errors = errors
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function isValidCost(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

/**
 * Validates values before they are persisted. In particular, a protocol is
 * only saveable after an adapter has been registered for it.
 */
export function validateProviderProfile(profile: ProviderProfile): ProviderProfileValidationResult {
  const errors: string[] = []
  if (!profile.id.trim()) errors.push('缺少服务商 ID')
  if (!profile.name.trim()) errors.push('缺少服务商名称')
  if (!hasProviderAdapter(profile.apiProtocol)) errors.push(`协议 ${profile.apiProtocol} 尚未注册适配器`)
  if (!profile.baseUrl.trim()) errors.push('缺少 API Base URL')
  if (!profile.model.trim()) errors.push('缺少模型名称')
  if (!profile.apiKeyRef.trim()) errors.push('缺少 API Key 引用')

  const timeout = profile.timeoutPolicy
  if (!timeout || !isFiniteInteger(timeout.connectTimeoutMs) || timeout.connectTimeoutMs < 100 || timeout.connectTimeoutMs > 600_000) {
    errors.push('连接超时必须是 100~600000 毫秒的整数')
  }
  if (!timeout || !isFiniteInteger(timeout.firstByteTimeoutMs) || timeout.firstByteTimeoutMs < 100 || timeout.firstByteTimeoutMs > 600_000) {
    errors.push('首字节超时必须是 100~600000 毫秒的整数')
  }
  if (!timeout || !isFiniteInteger(timeout.totalTimeoutMs) || timeout.totalTimeoutMs < 100 || timeout.totalTimeoutMs > 1_800_000) {
    errors.push('总超时必须是 100~1800000 毫秒的整数')
  }
  if (timeout && timeout.totalTimeoutMs < Math.max(timeout.connectTimeoutMs, timeout.firstByteTimeoutMs)) {
    errors.push('总超时不能小于连接或首字节超时')
  }

  const retry = profile.retryPolicy
  if (!retry || !isFiniteInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 6) {
    errors.push('最大重试次数必须是 1~6 次的整数')
  }
  if (!retry || !isFiniteInteger(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > 60_000) {
    errors.push('重试基础延迟必须是 0~60000 毫秒的整数')
  }
  if (!retry || !isFiniteInteger(retry.maxDelayMs) || retry.maxDelayMs < 0 || retry.maxDelayMs > 300_000) {
    errors.push('重试最大延迟必须是 0~300000 毫秒的整数')
  }
  if (retry && retry.maxDelayMs < retry.baseDelayMs) errors.push('重试最大延迟不能小于基础延迟')

  if (profile.contextWindow !== undefined && (!isFiniteInteger(profile.contextWindow) || profile.contextWindow <= 0)) errors.push('上下文窗口必须是正整数')
  if (profile.maxOutputTokens !== undefined && (!isFiniteInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0)) errors.push('最大输出 Token 必须是正整数')
  if (!isValidCost(profile.costProfile?.inputPerMillionTokens) || !isValidCost(profile.costProfile?.outputPerMillionTokens) || !isValidCost(profile.costProfile?.imagePerRequest)) {
    errors.push('成本配置必须是非负数字')
  }

  return { valid: errors.length === 0, errors }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|authorization|secret|token|password|credential/i.test(key)
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue).filter((item): item is Exclude<unknown, undefined> => item !== undefined)
  }
  if (!isRecord(value)) return undefined

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue
    const sanitized = sanitizeJsonValue(nested)
    if (sanitized !== undefined) result[key] = sanitized
  }
  return result
}

function stripSecretsFromOverrides(overrides: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!overrides) return undefined
  const sanitized = sanitizeJsonValue(overrides)
  return isRecord(sanitized) ? sanitized : undefined
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function readFiniteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : fallback
}

function readFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readApiProtocol(value: unknown): ApiProtocol | null {
  if (value === undefined || value === null || value === '') return 'openai-chat'
  return value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages' || value === 'custom-compatible'
    ? value
    : null
}

function readCapabilities(value: unknown): ProviderCapabilities {
  const source = isRecord(value) ? value : {}
  const structuredOutput = source.structuredOutput === 'json_schema' || source.structuredOutput === 'json_object'
    ? source.structuredOutput
    : 'none'
  return {
    vision: source.vision === true,
    structuredOutput,
    reasoning: source.reasoning === true,
    streaming: source.streaming === true,
    verified: source.verified === true,
  }
}

function readTimeoutPolicy(value: unknown): TimeoutPolicy {
  const source = isRecord(value) ? value : {}
  return {
    connectTimeoutMs: readFiniteInteger(source.connectTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_POLICY.connectTimeoutMs),
    firstByteTimeoutMs: readFiniteInteger(source.firstByteTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_POLICY.firstByteTimeoutMs),
    totalTimeoutMs: readFiniteInteger(source.totalTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_POLICY.totalTimeoutMs),
  }
}

function readRetryPolicy(value: unknown): RetryPolicy {
  const source = isRecord(value) ? value : {}
  return {
    maxAttempts: readFiniteInteger(source.maxAttempts, DEFAULT_PROVIDER_RETRY_POLICY.maxAttempts),
    baseDelayMs: readFiniteInteger(source.baseDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs),
    maxDelayMs: readFiniteInteger(source.maxDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs),
  }
}

function readCostProfile(value: unknown): CostProfile | undefined {
  if (!isRecord(value)) return undefined
  const result: CostProfile = {}
  const input = readFiniteNonNegative(value.inputPerMillionTokens)
  const output = readFiniteNonNegative(value.outputPerMillionTokens)
  const image = readFiniteNonNegative(value.imagePerRequest)
  if (input !== undefined) result.inputPerMillionTokens = input
  if (output !== undefined) result.outputPerMillionTokens = output
  if (image !== undefined) result.imagePerRequest = image
  const currency = readString(value.currency)
  if (currency) result.currency = currency.slice(0, 12)
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeApiKeyRef(value: unknown, providerId: string): string {
  const reference = readString(value)
  // Only the application-owned reference form is persisted. Anything else may
  // be an accidentally pasted credential and is replaced with a safe default.
  return /^provider:[A-Za-z0-9._:-]+$/.test(reference) ? reference : `provider:${providerId}`
}

/**
 * Normalizes unknown persisted data into the allowlisted ProviderProfile shape.
 * It is intentionally separate from validation: migration must be able to
 * clean malformed data before the store attempts to validate or save it.
 */
export function normalizeProviderProfile(value: unknown): ProviderProfile | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  if (!id) return null

  const apiProtocol = readApiProtocol(value.apiProtocol)
  // A non-empty but unknown protocol must not be silently reinterpreted as
  // OpenAI Chat, because that could send a request using the wrong contract.
  if (!apiProtocol) return null

  const profile: ProviderProfile = {
    id,
    name: readString(value.name, id),
    apiProtocol,
    baseUrl: readString(value.baseUrl),
    model: readString(value.model),
    enabled: value.enabled !== false,
    priority: readFiniteInteger(value.priority, 1),
    apiKeyRef: normalizeApiKeyRef(value.apiKeyRef, id),
    capabilities: readCapabilities(value.capabilities),
    timeoutPolicy: readTimeoutPolicy(value.timeoutPolicy),
    retryPolicy: readRetryPolicy(value.retryPolicy),
  }

  const contextWindow = readFiniteInteger(value.contextWindow, 0)
  if (contextWindow > 0) profile.contextWindow = contextWindow
  const maxOutputTokens = readFiniteInteger(value.maxOutputTokens, 0)
  if (maxOutputTokens > 0) profile.maxOutputTokens = maxOutputTokens

  const costProfile = readCostProfile(value.costProfile)
  if (costProfile) profile.costProfile = costProfile

  const requestOverrides = stripSecretsFromOverrides(isRecord(value.requestOverrides) ? value.requestOverrides : undefined)
  if (requestOverrides) profile.requestOverrides = requestOverrides

  return profile
}

/** Returns a persistence-safe, allowlisted profile; API key material is never copied. */
export function sanitizeProviderProfile(profile: ProviderProfile): ProviderProfile {
  const normalized = normalizeProviderProfile(profile)
  if (!normalized) {
    throw new ProviderProfileValidationError(['服务商配置缺少有效 ID'])
  }
  return normalized
}

export function assertValidProviderProfile(profile: ProviderProfile): ProviderProfile {
  const sanitized = sanitizeProviderProfile(profile)
  const result = validateProviderProfile(sanitized)
  if (!result.valid) throw new ProviderProfileValidationError(result.errors)
  return sanitized
}

import { describe, expect, it } from 'vitest'
import { ClassifiedLLMError } from './errors'
import { createProviderCapabilityMismatchError, evaluateProviderRoute, assertSupportedProviderProtocol } from './providerRouting'
import { getTaskProfile } from './taskProfiles'
import type { ProviderProfile } from './types'

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider',
    name: 'Provider',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://example.test/v1',
    model: 'model-with-any-name',
    enabled: true,
    priority: 1,
    apiKeyRef: 'provider:provider',
    capabilities: {
      vision: true,
      structuredOutput: 'json_schema',
      reasoning: true,
      streaming: false,
      verified: true,
    },
    timeoutPolicy: { connectTimeoutMs: 1_000, firstByteTimeoutMs: 2_000, totalTimeoutMs: 3_000 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    ...overrides,
  }
}

describe('provider capability routing', () => {
  it('filters an image task from a provider without vision capability', () => {
    const result = evaluateProviderRoute(provider({ capabilities: { ...provider().capabilities, vision: false } }), {
      ...getTaskProfile('todo-extraction'),
      needsVision: true,
    })

    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('视觉输入')
  })

  it('downgrades reasoning only from declared capabilities, never model names', () => {
    const result = evaluateProviderRoute(provider({ model: 'o3-mini', capabilities: { ...provider().capabilities, reasoning: false } }), {
      ...getTaskProfile('writing'),
      reasoning: 'high',
    }, { allowExperimentalDegradations: true })

    expect(result.compatible).toBe(true)
    expect(result.task.reasoning).toBe('disabled')
    expect(result.degradations).toContain('reasoning-disabled')
  })

  it('rejects a structured task when the provider has no structured output capability', () => {
    const result = evaluateProviderRoute(provider({ capabilities: { ...provider().capabilities, structuredOutput: 'none' } }), {
      ...getTaskProfile('todo-extraction'),
      needsStructuredOutput: true,
    })

    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('结构化输出')
  })

  it('rejects unknown protocols instead of falling back to OpenAI Chat', () => {
    const unknown = provider({ apiProtocol: 'unknown-protocol' as ProviderProfile['apiProtocol'] })
    expect(evaluateProviderRoute(unknown, getTaskProfile('writing')).compatible).toBe(false)
    expect(() => assertSupportedProviderProtocol(unknown)).toThrowError(ClassifiedLLMError)
    expect(createProviderCapabilityMismatchError(getTaskProfile('writing'), 'test')).toBeInstanceOf(ClassifiedLLMError)
  })
})

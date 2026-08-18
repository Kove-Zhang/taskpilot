import { describe, expect, it } from 'vitest'
import {
  createProviderProfileFromLegacy,
  createProviderProfilesFromLegacy,
  assertValidProviderProfile,
  sanitizeProviderProfile,
  validateProviderProfile,
} from './providerProfiles'

const legacyProvider = {
  id: 'primary',
  name: '主力服务商',
  apiBaseUrl: 'https://api.example.test/v1',
  modelName: 'example-chat',
  enabled: true,
  priority: 1,
}

describe('provider profile migration mapping', () => {
  it('maps a legacy provider without moving its API key into the profile', () => {
    const profile = createProviderProfileFromLegacy(legacyProvider)

    expect(profile).toMatchObject({
      id: 'primary',
      name: '主力服务商',
      apiProtocol: 'openai-chat',
      baseUrl: legacyProvider.apiBaseUrl,
      model: legacyProvider.modelName,
      apiKeyRef: 'provider:primary',
      capabilities: {
        vision: true,
        structuredOutput: 'json_object',
        verified: false,
      },
    })
    expect('apiKey' in profile).toBe(false)
  })

  it('updates legacy fields while preserving configured profile metadata', () => {
    const existingProfile = createProviderProfileFromLegacy(legacyProvider)
    const configuredProfile = {
      ...existingProfile,
      apiProtocol: 'custom-compatible' as const,
      capabilities: {
        ...existingProfile.capabilities,
        vision: false,
        structuredOutput: 'json_schema' as const,
        verified: true,
      },
      requestOverrides: { temperature: 0.2 },
    }

    const result = createProviderProfileFromLegacy(
      { ...legacyProvider, apiBaseUrl: 'https://new.example.test/v1', modelName: 'new-model' },
      configuredProfile,
    )

    expect(result).toMatchObject({
      apiProtocol: 'custom-compatible',
      baseUrl: 'https://new.example.test/v1',
      model: 'new-model',
      capabilities: { ...configuredProfile.capabilities, verified: false },
      requestOverrides: { temperature: 0.2 },
    })
  })

  it('matches existing metadata by provider id and preserves provider order', () => {
    const existingProfile = createProviderProfileFromLegacy(legacyProvider)
    const profiles = createProviderProfilesFromLegacy(
      [
        { ...legacyProvider, id: 'secondary', priority: 2 },
        legacyProvider,
      ],
      [existingProfile],
    )

    expect(profiles.map((profile) => profile.id)).toEqual(['secondary', 'primary'])
    expect(profiles[1].apiKeyRef).toBe('provider:primary')
  })
})


describe('provider profile safety validation', () => {
  it('rejects an unregistered protocol and invalid timeout/retry values', () => {
    const profile = {
      ...createProviderProfileFromLegacy(legacyProvider),
      apiProtocol: 'anthropic-messages' as const,
      timeoutPolicy: { connectTimeoutMs: 0, firstByteTimeoutMs: 1, totalTimeoutMs: 1 },
      retryPolicy: { maxAttempts: 7, baseDelayMs: 100, maxDelayMs: 10 },
    }
    const result = validateProviderProfile(profile)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('尚未注册')
    expect(() => assertValidProviderProfile(profile)).toThrow()
  })

  it('removes API key-like fields from a persistence profile and keeps verified explicit', () => {
    const profile = createProviderProfileFromLegacy(legacyProvider)
    const unsafe = { ...profile, apiKey: 'secret', requestOverrides: { temperature: 0.2, apiKey: 'secret', authorization: 'Bearer secret' } } as typeof profile & { apiKey: string }
    const sanitized = sanitizeProviderProfile(unsafe)
    expect('apiKey' in sanitized).toBe(false)
    expect(sanitized.requestOverrides).toEqual({ temperature: 0.2 })
    expect(sanitized.capabilities.verified).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { migrateSettingsState, SETTINGS_PERSIST_VERSION, useSettingsStore } from './store'

describe('release migration gate', () => {
  it('migrates legacy providers, preserves the encrypted-key mirror, and keeps keys out of profiles', () => {
    const migrated = migrateSettingsState({
      apiBaseUrl: 'https://legacy.example/v1',
      apiKey: 'legacy-secret-ciphertext',
      modelName: 'legacy-model',
      llmProviders: [{
        id: 'legacy', name: 'Legacy', apiBaseUrl: 'https://legacy.example/v1', apiKey: 'legacy-secret-ciphertext', modelName: 'legacy-model', enabled: true, priority: 1,
      }],
    }, 0)
    expect(migrated.llmProviders).toMatchObject([{ apiKey: 'legacy-secret-ciphertext' }])
    expect(migrated.providerProfiles).toMatchObject([{ id: 'legacy', model: 'legacy-model' }])
    expect(JSON.stringify(migrated.providerProfiles)).not.toContain('legacy-secret-ciphertext')
    expect(migrated.tokenLimit).toBe(migrated.maxInputChars)
  })


  it('sanitizes current-version profiles recursively before returning persisted state', () => {
    const migrated = migrateSettingsState({
      experimentalLLMRoutingEnabled: false,
      providerProfiles: [{
        id: 'unsafe',
        name: 'Unsafe',
        apiProtocol: 'custom-compatible',
        baseUrl: 'https://unsafe.example/v1',
        model: 'unsafe-model',
        enabled: true,
        priority: 2,
        apiKeyRef: 'Bearer real-secret-value',
        apiKey: 'real-secret-value',
        capabilities: { vision: false, structuredOutput: 'json_object', reasoning: false, streaming: false, verified: true },
        timeoutPolicy: { connectTimeoutMs: 1000, firstByteTimeoutMs: 2000, totalTimeoutMs: 3000 },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20 },
        requestOverrides: {
          headers: {
            Authorization: 'Bearer real-secret-value',
            'X-Api-Key': 'real-secret-value',
            'X-Trace': 'safe-value',
            nested: { token: 'real-secret-value', region: 'test' },
          },
          temperature: 0.2,
        },
        unknownField: 'must-not-persist',
      }],
    }, SETTINGS_PERSIST_VERSION)

    const profile = (migrated.providerProfiles as Array<Record<string, unknown>>)[0]
    expect(profile).toMatchObject({
      id: 'unsafe',
      apiKeyRef: 'provider:unsafe',
      requestOverrides: {
        headers: { 'X-Trace': 'safe-value', nested: { region: 'test' } },
        temperature: 0.2,
      },
    })
    expect(profile).not.toHaveProperty('apiKey')
    expect(profile).not.toHaveProperty('unknownField')
    expect(JSON.stringify(migrated.providerProfiles)).not.toContain('real-secret-value')
    expect(migrated.experimentalLLMRoutingEnabled).toBe(false)
    expect(migrated.experimentalProviderHealthEnabled).toBe(false)
  })

  it('defaults prompt logging to off while preserving an explicit saved value', () => {
    const defaults = migrateSettingsState({ providerProfiles: [] }, SETTINGS_PERSIST_VERSION - 1)
    expect(defaults.enablePromptLogging).toBe(false)

    const explicit = migrateSettingsState({
      providerProfiles: [],
      enablePromptLogging: true,
    }, SETTINGS_PERSIST_VERSION)
    expect(explicit.enablePromptLogging).toBe(true)
  })

  it('defaults omitted experimental flags to off while preserving explicit saved values', () => {
    const defaults = migrateSettingsState({ providerProfiles: [] }, SETTINGS_PERSIST_VERSION - 1)
    expect(defaults.experimentalLLMRoutingEnabled).toBe(false)
    expect(defaults.experimentalProviderHealthEnabled).toBe(false)

    const explicit = migrateSettingsState({
      providerProfiles: [],
      experimentalLLMRoutingEnabled: true,
      experimentalProviderHealthEnabled: true,
    }, SETTINGS_PERSIST_VERSION)
    expect(explicit.experimentalLLMRoutingEnabled).toBe(true)
    expect(explicit.experimentalProviderHealthEnabled).toBe(true)
  })

  it('drops a current-version profile with an unknown non-empty protocol instead of reinterpreting it', () => {
    const migrated = migrateSettingsState({
      providerProfiles: [{ id: 'unknown', apiProtocol: 'unsupported-protocol', baseUrl: 'https://example.test', model: 'model' }],
    }, SETTINGS_PERSIST_VERSION)
    expect(migrated.providerProfiles).toEqual([])
  })

  it('keeps current-version focus and provider state while normalizing mirrors', () => {
    const migrated = migrateSettingsState({
      providerProfiles: [],
      maxInputChars: 1234,
      tokenLimit: 999,
      focusCandidates: [],
      focusVersions: [],
    }, SETTINGS_PERSIST_VERSION)
    expect(migrated.maxInputChars).toBe(1234)
    expect(migrated.tokenLimit).toBe(1234)
    expect(migrated.providerProfiles).toEqual([])
  })

  it('migrates legacy email read settings into structured IMAP scan filters', () => {
    const migrated = migrateSettingsState({
      providerProfiles: [],
      emailConfig: {
        autoUnreadOnly: false,
        manualUnreadOnly: true,
        autoScanFilter: {
          readState: 'read',
          systemFlags: ['flagged', 'not-supported'],
          keywords: [' Project-A ', '', 'Project-A'],
          excludeKeywords: ['newsletter'],
        },
      },
    }, SETTINGS_PERSIST_VERSION - 1)

    expect(migrated.emailConfig).toMatchObject({
      autoScanFilter: {
        readState: 'read',
        systemFlags: ['flagged'],
        keywords: ['Project-A'],
        excludeKeywords: ['newsletter'],
      },
      manualScanFilter: {
        readState: 'unread',
        systemFlags: [],
        keywords: [],
        excludeKeywords: [],
      },
    })
  })

  it('supports the release rollback controls for flags and provider profiles', () => {
    const before = useSettingsStore.getState()
    const originalFlags = {
      routing: before.experimentalLLMRoutingEnabled,
      health: before.experimentalProviderHealthEnabled,
    }
    const originalProfiles = before.providerProfiles

    useSettingsStore.getState().setExperimentalLLMFlags(true, true)
    expect(useSettingsStore.getState()).toMatchObject({ experimentalLLMRoutingEnabled: true, experimentalProviderHealthEnabled: true })

    useSettingsStore.getState().setExperimentalLLMFlags(false, false)
    expect(useSettingsStore.getState()).toMatchObject({ experimentalLLMRoutingEnabled: false, experimentalProviderHealthEnabled: false })

    useSettingsStore.getState().setProviderProfiles(originalProfiles.map((profile) => ({ ...profile, enabled: false })))
    expect(useSettingsStore.getState().providerProfiles.every((profile) => !profile.enabled)).toBe(true)

    useSettingsStore.setState({
      experimentalLLMRoutingEnabled: originalFlags.routing,
      experimentalProviderHealthEnabled: originalFlags.health,
      providerProfiles: originalProfiles,
    })
  })

})

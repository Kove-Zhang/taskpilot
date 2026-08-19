import { describe, expect, it } from 'vitest'
import { createProviderProfileFromLegacy } from './providerProfiles'
import { getProviderProbeFingerprint, runProviderProbe } from './providerProbe'
import type { ProviderResponse } from './types'
import { HttpRequestError } from '../http'

const profile = createProviderProfileFromLegacy({
  id: 'probe', name: 'Probe', apiBaseUrl: 'https://api.example.test/v1', modelName: 'probe-model', enabled: true, priority: 1,
})

function response(body: unknown, status = 200): ProviderResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }
}

describe('provider probes', () => {
  it('sends a short JSON Schema request without business content and parses JSON', async () => {
    let captured: Record<string, unknown> | undefined
    const result = await runProviderProbe({
      profile,
      apiKey: 'secret-key',
      kind: 'structured-output',
      request: async ({ request }) => {
        captured = request.body
        const responseFormat = captured.response_format as { json_schema?: { schema?: { properties?: { probeId?: { const?: string } } } } }
        const probeId = responseFormat.json_schema?.schema?.properties?.probeId?.const
        return response({ choices: [{ message: { content: JSON.stringify({ ok: true, probeId }) } }] })
      },
    })
    expect(result).toMatchObject({ success: true, detectedStructuredOutput: 'json_schema' })
    expect(result.probeId).toBeTruthy()
    expect(result.fingerprint).toBe(getProviderProbeFingerprint(profile, 'structured-output'))
    expect(result.diagnostics).toMatchObject({ transport: 'custom-rust', host: 'api.example.test' })
    expect(captured?.response_format).toMatchObject({ type: 'json_schema' })
    expect(JSON.stringify(captured)).not.toContain('secret-key')
    expect(JSON.stringify(captured)).not.toContain('邮件')
  })

  it('falls back to JSON Object but does not claim JSON Schema for a non-strict response', async () => {
    let requestCount = 0
    let probeIdFromFirstRequest: string | undefined
    const result = await runProviderProbe({
      profile,
      apiKey: 'secret-key',
      kind: 'structured-output',
      request: async ({ request, timeoutPolicy }) => {
        expect(timeoutPolicy).toEqual(profile.timeoutPolicy)
        requestCount += 1
        const format = request.body.response_format as { type?: string; json_schema?: { schema?: { properties?: { probeId?: { const?: string } } } } }
        const probeId = format.json_schema?.schema?.properties?.probeId?.const ?? probeIdFromFirstRequest
        probeIdFromFirstRequest = probeId
        return response({ choices: [{ message: { content: JSON.stringify({ ok: true, probeId, extra: 'not-schema' }) } }] })
      },
    })
    expect(result).toMatchObject({ success: true, detectedStructuredOutput: 'json_object' })
    expect(requestCount).toBe(2)
  })

  it('does not claim success when both structured probe responses are malformed', async () => {
    const result = await runProviderProbe({
      profile,
      apiKey: 'secret-key',
      kind: 'structured-output',
      request: async () => response({ choices: [{ message: { content: 'not-json' } }] }),
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('有效 JSON')
  })

  it('uses an explicit no-retry probe policy and invalidates fingerprints when capability strategy changes', async () => {
    const modified = {
      ...profile,
      capabilities: { ...profile.capabilities, reasoning: !profile.capabilities.reasoning },
      requestOverrides: { extra_headers: { 'x-probe-mode': 'strict' } },
    }
    expect(getProviderProbeFingerprint(modified, 'connection')).not.toBe(getProviderProbeFingerprint(profile, 'connection'))

    const result = await runProviderProbe({
      profile: modified,
      apiKey: 'secret-key',
      kind: 'connection',
      request: async ({ timeoutPolicy, retryPolicy }) => {
        expect(timeoutPolicy).toEqual(modified.timeoutPolicy)
        expect(retryPolicy).toEqual({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 })
        return response({ choices: [{ message: { content: 'ok' } }] })
      },
    })

    expect(result.success).toBe(true)
  })

  it('returns a redacted failure stage and timeout category without exposing the request body', async () => {
    const result = await runProviderProbe({
      profile,
      apiKey: 'secret-key',
      kind: 'connection',
      request: async () => {
        throw new HttpRequestError('请求超时（60 秒，阶段：first_byte）', { isTimeout: true, timeoutPhase: 'first_byte' })
      },
    })

    expect(result).toMatchObject({ success: false })
    expect(result.diagnostics).toMatchObject({
      transport: 'custom-rust',
      host: 'api.example.test',
      failureStage: 'before_response_headers',
      timeoutPhase: 'first_byte',
      errorCategory: 'timeout',
    })
    expect(JSON.stringify(result)).not.toContain('secret-key')
  })
})

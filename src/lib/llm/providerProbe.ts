import { getProviderAdapter } from './adapterRegistry'
import { getProviderTransportDiagnostics, getProviderTransportKind } from '../providerTransport'
import { HttpRequestError } from '../http'
import type { ProviderProfile, ProviderRequest, ProviderResponse, ProviderTransportDiagnostics, TaskProfile } from './types'

export type ProviderProbeKind = 'connection' | 'structured-output'
export type DetectedStructuredOutput = 'json_object' | 'json_schema'

export const PROVIDER_PROBE_VERSION = 'provider-probe-v2'

/** Probes never retry automatically; the user must explicitly re-run a test. */
export const PROVIDER_PROBE_RETRY_POLICY = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } as const

export interface ProviderProbeResult {
  kind: ProviderProbeKind
  success: boolean
  detectedStructuredOutput?: DetectedStructuredOutput
  status?: number
  responseId?: string
  probeId?: string
  fingerprint?: string
  durationMs: number
  error?: string
  diagnostics: ProviderProbeDiagnostics
}

export type ProviderProbeFailureStage = 'before_response_headers' | 'response_validation'
export type ProviderProbeErrorCategory = 'timeout' | 'tls' | 'dns' | 'connection' | 'http' | 'response' | 'unknown'

/** A deliberately small, persistence-safe snapshot. It never contains request or response content. */
export interface ProviderProbeDiagnostics {
  transport: ProviderTransportDiagnostics['transport']
  host: string
  responseHeadersMs?: number
  totalMs: number
  failureStage?: ProviderProbeFailureStage
  timeoutPhase?: 'connect' | 'first_byte' | 'total'
  errorCategory?: ProviderProbeErrorCategory
}

export interface ProviderProbeRequestOptions {
  profile: ProviderProfile
  apiKey: string
  kind: ProviderProbeKind
  request: (options: { baseUrl: string; apiKey: string; request: ProviderRequest; timeoutPolicy: ProviderProfile['timeoutPolicy']; retryPolicy: typeof PROVIDER_PROBE_RETRY_POLICY }) => Promise<ProviderResponse>
}

/** Base schema retained as a public diagnostic reference; live probes add a per-run probeId const. */
export const STRUCTURED_PROBE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    probeId: { type: 'string' },
  },
  required: ['ok', 'probeId'],
  additionalProperties: false,
}

function hashFingerprint(input: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
}

/** Stable, non-secret identity for binding a probe result to the edited target. */
export function getProviderProbeFingerprint(profile: ProviderProfile, kind: ProviderProbeKind): string {
  const identity = [
    PROVIDER_PROBE_VERSION,
    kind,
    profile.apiProtocol,
    normalizeBaseUrl(profile.baseUrl),
    profile.model.trim(),
    profile.capabilities.vision ? 'vision:1' : 'vision:0',
    'structured:' + profile.capabilities.structuredOutput,
    profile.capabilities.reasoning ? 'reasoning:1' : 'reasoning:0',
    profile.capabilities.streaming ? 'streaming:1' : 'streaming:0',
    stableFingerprintValue(profile.requestOverrides ?? {}),
  ].join('|')
  return `${PROVIDER_PROBE_VERSION}:${hashFingerprint(identity)}`
}

function stableFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableFingerprintValue).join(',') + ']'
  const record = value as Record<string, unknown>
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableFingerprintValue(record[key])).join(',') + '}'
}

function createProbeId(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function parseJsonObject(text: string, allowCodeFence = true): Record<string, unknown> | null {
  const trimmed = allowCodeFence
    ? text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    : text.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function createStructuredProbeSchema(probeId: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      probeId: { type: 'string', const: probeId },
    },
    required: ['ok', 'probeId'],
    additionalProperties: false,
  }
}

function validateProbeObject(text: string, probeId: string, strictSchema: boolean): Record<string, unknown> {
  const parsed = parseJsonObject(text, !strictSchema)
  if (!parsed) throw new Error('服务商未返回有效 JSON 对象')
  if (parsed.ok !== true) throw new Error('结构化探测响应缺少布尔值 ok=true')
  if (parsed.probeId !== probeId) throw new Error('结构化探测响应的 probeId 不匹配')
  if (strictSchema) {
    const keys = Object.keys(parsed).sort()
    if (keys.length !== 2 || keys[0] !== 'ok' || keys[1] !== 'probeId') {
      throw new Error('响应未严格符合 JSON Schema')
    }
  }
  return parsed
}

function createTask(kind: ProviderProbeKind): TaskProfile {
  if (kind === 'structured-output') {
    return {
      type: 'provider-health-check',
      needsVision: false,
      needsStructuredOutput: true,
      maxInputChars: 200,
      maxOutputTokens: 80,
      reasoning: 'disabled',
      allowFailover: false,
      allowRepair: false,
    }
  }
  return {
    type: 'provider-health-check',
    needsVision: false,
    needsStructuredOutput: false,
    maxInputChars: 200,
    maxOutputTokens: 20,
    reasoning: 'disabled',
    allowFailover: false,
    allowRepair: false,
  }
}

function safeProviderHost(baseUrl: string): string {
  try { return new URL(baseUrl).host.slice(0, 200) || '[invalid-url]' } catch { return '[invalid-url]' }
}

function classifyProbeError(error: unknown): ProviderProbeErrorCategory {
  if (error instanceof HttpRequestError && error.status !== undefined) return 'http'
  if (error instanceof HttpRequestError && error.isTimeout) return 'timeout'
  const message = error instanceof Error ? error.message : String(error)
  if (/tls|ssl|certificate|handshake|unexpected eof/i.test(message)) return 'tls'
  if (/dns|resolve|enotfound|eai_again|无法解析/i.test(message)) return 'dns'
  if (/network|socket|connection|econn|error\s+sending|发送请求/i.test(message)) return 'connection'
  if (/json|响应|output|content/i.test(message)) return 'response'
  return 'unknown'
}

function buildProbeDiagnostics(
  profile: ProviderProfile,
  startedAt: number,
  response?: ProviderResponse,
  error?: unknown,
): ProviderProbeDiagnostics {
  const transport = response?.transportDiagnostics ?? getProviderTransportDiagnostics(error)
  const totalMs = Math.max(0, Date.now() - startedAt)
  if (!error) {
    return {
      transport: transport?.transport ?? getProviderTransportKind(profile.baseUrl),
      host: safeProviderHost(profile.baseUrl),
      responseHeadersMs: transport?.responseHeadersMs,
      totalMs,
    }
  }
  return {
    transport: transport?.transport ?? getProviderTransportKind(profile.baseUrl),
    host: safeProviderHost(profile.baseUrl),
    responseHeadersMs: transport?.responseHeadersMs,
    totalMs,
    failureStage: transport?.responseHeadersMs === undefined ? 'before_response_headers' : 'response_validation',
    ...(error instanceof HttpRequestError && error.timeoutPhase ? { timeoutPhase: error.timeoutPhase } : {}),
    errorCategory: classifyProbeError(error),
  }
}

async function runStructuredModeProbe(
  options: ProviderProbeRequestOptions,
  probeId: string,
  mode: DetectedStructuredOutput,
  onResponse: (response: ProviderResponse) => void,
): Promise<{ status: number; responseId?: string; response: ProviderResponse }> {
  const adapter = getProviderAdapter(options.profile.apiProtocol)
  const task = createTask('structured-output')
  const probeProfile: ProviderProfile = {
    ...options.profile,
    capabilities: { ...options.profile.capabilities, structuredOutput: mode, verified: false },
  }
  const request = adapter.buildRequest({
    provider: probeProfile,
    apiKey: options.apiKey,
    task,
    schema: mode === 'json_schema' ? createStructuredProbeSchema(probeId) : undefined,
    envelope: {
      trustedInstructions: [
        '仅验证结构化输出能力。不要输出解释、Markdown 或代码块。',
        `只返回 JSON 对象：{"ok":true,"probeId":"${probeId}"}`,
      ],
      messages: [{ role: 'user', content: `返回 ok=true 且 probeId 必须精确等于 ${probeId}。` }],
    },
  })
  const response = await options.request({
    baseUrl: options.profile.baseUrl,
    apiKey: options.apiKey,
    request,
    timeoutPolicy: options.profile.timeoutPolicy,
    retryPolicy: PROVIDER_PROBE_RETRY_POLICY,
  })
  onResponse(response)
  const completion = await adapter.parseResponse(response)
  validateProbeObject(completion.text, probeId, mode === 'json_schema')
  return { status: response.status, responseId: completion.responseId, response }
}

/** Runs a short, redacted probe. It never receives email content or images. */
export async function runProviderProbe(options: ProviderProbeRequestOptions): Promise<ProviderProbeResult> {
  const startedAt = Date.now()
  const fingerprint = getProviderProbeFingerprint(options.profile, options.kind)
  let latestResponse: ProviderResponse | undefined
  try {
    if (options.kind === 'structured-output') {
      const probeId = createProbeId()
      let schemaFailure = ''
      try {
        latestResponse = undefined
        const result = await runStructuredModeProbe(options, probeId, 'json_schema', (response) => { latestResponse = response })
        return {
          kind: options.kind,
          success: true,
          detectedStructuredOutput: 'json_schema',
          status: result.status,
          responseId: result.responseId,
          probeId,
          fingerprint,
          durationMs: Date.now() - startedAt,
          diagnostics: buildProbeDiagnostics(options.profile, startedAt, result.response),
        }
      } catch (error) {
        schemaFailure = error instanceof Error ? error.message : String(error)
      }

      try {
        latestResponse = undefined
        const result = await runStructuredModeProbe(options, probeId, 'json_object', (response) => { latestResponse = response })
        return {
          kind: options.kind,
          success: true,
          detectedStructuredOutput: 'json_object',
          status: result.status,
          responseId: result.responseId,
          probeId,
          fingerprint,
          durationMs: Date.now() - startedAt,
          diagnostics: buildProbeDiagnostics(options.profile, startedAt, result.response),
        }
      } catch (error) {
        const objectFailure = error instanceof Error ? error.message : String(error)
        throw new Error(`JSON Schema 探测失败：${schemaFailure}；JSON Object 探测失败：${objectFailure}`)
      }
    }

    const adapter = getProviderAdapter(options.profile.apiProtocol)
    const request = adapter.buildRequest({
      provider: options.profile,
      apiKey: options.apiKey,
      task: createTask(options.kind),
      envelope: {
        trustedInstructions: ['只需返回 OK，不要输出其他内容。'],
        messages: [{ role: 'user', content: 'Say "OK" if you receive this.' }],
      },
    })
    latestResponse = await options.request({
    baseUrl: options.profile.baseUrl,
    apiKey: options.apiKey,
    request,
    timeoutPolicy: options.profile.timeoutPolicy,
    retryPolicy: PROVIDER_PROBE_RETRY_POLICY,
  })
    const completion = await adapter.parseResponse(latestResponse)
    if (!completion.text.trim()) throw new Error('服务商返回空响应')
    return {
      kind: options.kind,
      success: true,
      status: latestResponse.status,
      responseId: completion.responseId,
      fingerprint,
      durationMs: Date.now() - startedAt,
      diagnostics: buildProbeDiagnostics(options.profile, startedAt, latestResponse),
    }
  } catch (error) {
    return {
      kind: options.kind,
      success: false,
      fingerprint,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      diagnostics: buildProbeDiagnostics(options.profile, startedAt, latestResponse, error),
    }
  }
}

export { createStructuredProbeSchema }

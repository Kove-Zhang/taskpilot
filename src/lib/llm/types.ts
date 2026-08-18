/** Supported request protocols for an LLM provider. */
export type ApiProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'custom-compatible'

/** Capabilities that affect routing and request construction. */
export interface ProviderCapabilities {
  vision: boolean
  structuredOutput: 'none' | 'json_object' | 'json_schema'
  reasoning: boolean
  streaming: boolean
  /** False until the capability has been verified with a probe or fixture. */
  verified?: boolean
}

export interface TimeoutPolicy {
  connectTimeoutMs: number
  firstByteTimeoutMs: number
  totalTimeoutMs: number
}

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface CostProfile {
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  imagePerRequest?: number
  currency?: string
}

/**
 * Provider configuration used by the LLM layer.
 *
 * API keys deliberately do not belong in this contract. The runtime may resolve
 * a key from secure storage using apiKeyRef, but adapters and events should not
 * persist or log the secret itself.
 */
export interface ProviderProfile {
  id: string
  name: string
  apiProtocol: ApiProtocol
  baseUrl: string
  model: string
  enabled: boolean
  priority: number
  apiKeyRef: string
  capabilities: ProviderCapabilities
  contextWindow?: number
  maxOutputTokens?: number
  timeoutPolicy: TimeoutPolicy
  retryPolicy: RetryPolicy
  costProfile?: CostProfile
  requestOverrides?: Record<string, unknown>
}

export type LLMTaskType =
  | 'todo-extraction'
  | 'writing'
  | 'prompt-optimization'
  | 'history-learning'
  | 'provider-health-check'
  | 'schema-repair'

export type ReasoningMode = 'disabled' | 'low' | 'high'

export interface TaskProfile {
  type: LLMTaskType
  needsVision: boolean
  needsStructuredOutput: boolean
  maxInputChars: number
  maxOutputTokens: number
  temperature?: number
  reasoning: ReasoningMode
  allowFailover: boolean
  allowRepair: boolean
}

export type LLMMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type LLMMessageContent = string | Array<Record<string, unknown>>

export interface LLMMessage {
  role: LLMMessageRole
  content: LLMMessageContent
}

export interface InputEnvelope {
  trustedInstructions: string[]
  messages: LLMMessage[]
  untrustedContent?: {
    text?: string
    imageCount?: number
    source: 'manual' | 'email' | 'history' | 'unknown'
  }
}

export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

export interface NormalizedCompletion {
  text: string
  usage?: CompletionUsage
  finishReason?: string
  responseId?: string
  rawMetadata?: Record<string, unknown>
}

export interface ProviderRequest {
  endpoint: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface ProviderResponse {
  ok: boolean
  status: number
  /** Non-secret transport correlation ID; present for custom Tauri requests. */
  requestId?: string
  /** Non-secret operation correlation ID shared by retry/failover attempts. */
  traceId?: string
  headers?: Headers
  text(): Promise<string>
  json(): Promise<unknown>
}

export interface AdapterInput {
  provider: ProviderProfile
  /** Runtime-only secret resolved from secure storage; never part of ProviderProfile. */
  apiKey?: string
  task: TaskProfile
  envelope: InputEnvelope
  schema?: Record<string, unknown>
  signal?: AbortSignal
}

export interface ProviderAdapter {
  readonly protocol: ApiProtocol
  buildRequest(input: AdapterInput): ProviderRequest
  parseResponse(response: ProviderResponse): Promise<NormalizedCompletion>
}

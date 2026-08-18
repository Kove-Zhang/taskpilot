import { ClassifiedLLMError } from '../errors'
import type {
  AdapterInput,
  LLMMessage,
  NormalizedCompletion,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
} from '../types'
import type { ApiProtocol } from '../types'
import { getRetryAfterMs } from '../retryPolicy'

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'
const DEFAULT_SCHEMA_NAME = 'task_pilot_output'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function buildOpenAIChatEndpoint(baseUrl: string): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new ClassifiedLLMError('invalid_request', '服务商未配置 API Base URL')
  }
  return normalizedBaseUrl.endsWith(CHAT_COMPLETIONS_SUFFIX)
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}${CHAT_COMPLETIONS_SUFFIX}`
}

function getMessages(input: AdapterInput): LLMMessage[] {
  const trustedInstructions = input.envelope.trustedInstructions
    .map((instruction) => instruction.trim())
    .filter(Boolean)
  const messages: LLMMessage[] = []

  if (trustedInstructions.length > 0) {
    messages.push({ role: 'system', content: trustedInstructions.join('\n\n') })
  }

  messages.push(...input.envelope.messages)
  return messages
}

function getStructuredOutput(input: AdapterInput): Record<string, unknown> | undefined {
  if (!input.task.needsStructuredOutput) return undefined

  const structuredOutput = input.provider.capabilities.structuredOutput
  if (structuredOutput === 'json_schema' && input.schema) {
    return {
      type: 'json_schema',
      json_schema: {
        name: DEFAULT_SCHEMA_NAME,
        strict: true,
        schema: input.schema,
      },
    }
  }

  if (structuredOutput === 'json_schema' || structuredOutput === 'json_object') {
    return { type: 'json_object' }
  }

  return undefined
}

function getMaxOutputTokens(input: AdapterInput): number | undefined {
  const configuredLimits: number[] = []
  if (Number.isFinite(input.task.maxOutputTokens) && input.task.maxOutputTokens > 0) {
    configuredLimits.push(input.task.maxOutputTokens)
  }
  const providerMaxOutputTokens = input.provider.maxOutputTokens
  if (providerMaxOutputTokens !== undefined
    && Number.isFinite(providerMaxOutputTokens)
    && providerMaxOutputTokens > 0) {
    configuredLimits.push(providerMaxOutputTokens)
  }
  if (configuredLimits.length === 0) return undefined
  return Math.min(...configuredLimits)
}

function buildRequestBody(input: AdapterInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...input.provider.requestOverrides,
    model: input.provider.model,
    messages: getMessages(input),
  }

  const responseFormat = getStructuredOutput(input)
  if (responseFormat) body.response_format = responseFormat

  const maxOutputTokens = getMaxOutputTokens(input)
  if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens

  if (input.task.temperature !== undefined && body.temperature === undefined) {
    body.temperature = input.task.temperature
  }

  if (input.task.reasoning !== 'disabled'
    && input.provider.capabilities.reasoning
    && body.reasoning_effort === undefined) {
    body.reasoning_effort = input.task.reasoning
  }

  return body
}

function normalizeCompletionText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      if (!isRecord(part)) return ''
      return typeof part.text === 'string' ? part.text : ''
    })
    .filter(Boolean)
    .join('')
    .trim()
}

function classifyHttpStatus(status: number): {
  errorClass: 'timeout' | 'transient' | 'rate_limited' | 'server_error' | 'auth' | 'invalid_request'
  retryable: boolean
  failoverable: boolean
  userActionRequired: boolean
} {
  if (status === 408) {
    return { errorClass: 'timeout', retryable: true, failoverable: true, userActionRequired: false }
  }
  if (status === 409 || status === 425) {
    return { errorClass: 'transient', retryable: true, failoverable: true, userActionRequired: false }
  }
  if (status === 429) {
    return { errorClass: 'rate_limited', retryable: true, failoverable: true, userActionRequired: false }
  }
  if (status >= 500) {
    return { errorClass: 'server_error', retryable: true, failoverable: true, userActionRequired: false }
  }
  if (status === 401 || status === 403) {
    return { errorClass: 'auth', retryable: false, failoverable: false, userActionRequired: true }
  }
  return { errorClass: 'invalid_request', retryable: false, failoverable: false, userActionRequired: true }
}

function getUsage(data: Record<string, unknown>) {
  if (!isRecord(data.usage)) return undefined

  const usage = data.usage
  const inputTokens = typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : undefined
  const outputTokens = typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : undefined
  const reasoningTokens = typeof usage.reasoning_tokens === 'number'
    ? usage.reasoning_tokens
    : undefined

  if (inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined) {
    return undefined
  }

  return { inputTokens, outputTokens, reasoningTokens }
}

export class OpenAIChatAdapter implements ProviderAdapter {
  readonly protocol: ApiProtocol

  constructor(protocol: 'openai-chat' | 'custom-compatible' = 'openai-chat') {
    this.protocol = protocol
  }

  buildRequest(input: AdapterInput): ProviderRequest {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (input.apiKey?.trim()) {
      headers.Authorization = `Bearer ${input.apiKey.trim()}`
    }

    return {
      endpoint: buildOpenAIChatEndpoint(input.provider.baseUrl),
      headers,
      body: buildRequestBody(input),
    }
  }

  async parseResponse(response: ProviderResponse): Promise<NormalizedCompletion> {
    if (!response.ok) {
      const classification = classifyHttpStatus(response.status)
      throw new ClassifiedLLMError(classification.errorClass, `OpenAI-compatible 请求失败（HTTP ${response.status}）`, {
        status: response.status,
        retryable: classification.retryable,
        failoverable: classification.failoverable,
        userActionRequired: classification.userActionRequired,
        retryAfterMs: getRetryAfterMs(response.headers),
      })
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (cause) {
      throw new ClassifiedLLMError('invalid_response', 'OpenAI-compatible 服务商返回的响应不是有效 JSON', {
        status: response.status,
        retryable: true,
        failoverable: true,
        cause,
      })
    }

    if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0 || !isRecord(data.choices[0])) {
      throw new ClassifiedLLMError('invalid_response', 'OpenAI-compatible 响应缺少 choices[0]', {
        status: response.status,
        retryable: false,
        failoverable: false,
      })
    }

    const choice = data.choices[0]
    const message = isRecord(choice.message) ? choice.message : undefined
    const text = normalizeCompletionText(message?.content)
    if (!text) {
      throw new ClassifiedLLMError('invalid_response', 'OpenAI-compatible 响应缺少有效 message.content', {
        status: response.status,
        retryable: false,
        failoverable: false,
      })
    }

    return {
      text,
      usage: getUsage(data),
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
      responseId: typeof data.id === 'string' ? data.id : undefined,
      rawMetadata: {
        providerProtocol: this.protocol,
      },
    }
  }
}



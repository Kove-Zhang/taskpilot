import type { InputEnvelope, LLMMessage, LLMMessageContent, ProviderProfile, TaskProfile } from './types'

/** Conservative estimate used when a provider does not expose a tokenizer. */
export const ESTIMATED_CHARS_PER_TOKEN = 2
export const DEFAULT_MAX_IMAGE_COUNT = 4
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024
const TRUNCATION_NOTICE = '\n[上下文已按任务预算截断。]'
const UNTRUSTED_CLOSE_TAG = '</untrusted-content>'

export interface ContextBudgetOptions {
  task: Pick<TaskProfile, 'maxInputChars' | 'maxOutputTokens'>
  provider?: Pick<ProviderProfile, 'contextWindow' | 'maxOutputTokens'>
  /** Legacy/user-facing setting. It is interpreted as maximum input characters. */
  maxInputChars?: number
  maxImageCount?: number
  maxImageBytes?: number
  schema?: Record<string, unknown>
}

export interface ContextBudgetMetadata {
  originalChars: number
  keptChars: number
  truncated: boolean
  estimatedInputTokens: number
  maxInputChars: number
  maxOutputTokens: number
  contextWindow?: number
  originalImageCount: number
  keptImageCount: number
  droppedImageCount: number
  originalImageBytes: number
  keptImageBytes: number
  maxImageCount: number
  maxImageBytes: number
}

export interface ContextBudgetResult {
  envelope: InputEnvelope
  metadata: ContextBudgetMetadata
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return undefined
  return Math.floor(value)
}

function contentTextLength(content: LLMMessageContent): number {
  if (typeof content === 'string') return content.length
  return content.reduce((total, item) => total + (item.type === 'text' && typeof item.text === 'string' ? item.text.length : 0), 0)
}

function imageUrlFromPart(part: Record<string, unknown>): string | undefined {
  if (typeof part.image_url === 'string') return part.image_url
  if (part.image_url && typeof part.image_url === 'object' && !Array.isArray(part.image_url)) {
    const url = (part.image_url as Record<string, unknown>).url
    return typeof url === 'string' ? url : undefined
  }
  return undefined
}

/** Returns a conservative byte estimate for data URLs and ordinary image URLs. */
export function estimateImageBytes(url: string): number {
  const commaIndex = url.indexOf(',')
  if (url.slice(0, commaIndex).toLowerCase().includes(';base64') && commaIndex >= 0) {
    const payload = url.slice(commaIndex + 1).replace(/\s/g, '')
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
  }
  return url.length * 2
}

function truncateTextPreservingBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 0) return ''
  if (maxLength <= TRUNCATION_NOTICE.length) return value.slice(0, maxLength)

  const openIndex = value.indexOf('<untrusted-content')
  const openEnd = openIndex >= 0 ? value.indexOf('>', openIndex) : -1
  const closeIndex = value.lastIndexOf(UNTRUSTED_CLOSE_TAG)
  if (openEnd >= 0 && closeIndex > openEnd) {
    const prefix = value.slice(0, openEnd + 1)
    const suffix = UNTRUSTED_CLOSE_TAG
    const available = maxLength - prefix.length - suffix.length - TRUNCATION_NOTICE.length
    if (available > 0) {
      return `${prefix}${value.slice(openEnd + 1, closeIndex).slice(0, available)}${TRUNCATION_NOTICE}${suffix}`
    }
  }

  const available = Math.max(0, maxLength - TRUNCATION_NOTICE.length)
  return `${value.slice(0, available)}${TRUNCATION_NOTICE}`.slice(0, maxLength)
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return positiveInteger(value) ?? fallback
}

function getSchemaChars(schema: Record<string, unknown> | undefined): number {
  if (!schema) return 0
  try {
    return JSON.stringify(schema).length
  } catch {
    return 0
  }
}

function countOriginalImages(envelope: InputEnvelope): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const message of envelope.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'image_url') continue
      const url = imageUrlFromPart(part)
      if (!url) continue
      count += 1
      bytes += estimateImageBytes(url)
    }
  }
  return { count, bytes }
}

function getTrustedChars(envelope: InputEnvelope): number {
  return envelope.trustedInstructions.join('\n').length
    + envelope.messages
      .filter((message) => message.role === 'system')
      .reduce((total, message) => total + contentTextLength(message.content), 0)
}

function getEffectiveOutputTokens(options: ContextBudgetOptions): number {
  const taskLimit = positiveInteger(options.task.maxOutputTokens) ?? 0
  const providerLimit = positiveInteger(options.provider?.maxOutputTokens)
  return providerLimit === undefined ? taskLimit : Math.min(taskLimit, providerLimit)
}

/**
 * Applies one deterministic budget to all non-system content in an input envelope.
 * System instructions and output schema are reserved first; user data is trimmed
 * only after those fixed parts have been accounted for.
 */
export function budgetInputEnvelope(envelope: InputEnvelope, options: ContextBudgetOptions): ContextBudgetResult {
  const taskLimit = normalizeLimit(options.task.maxInputChars, 1)
  const configuredLimit = positiveInteger(options.maxInputChars)
  const maxOutputTokens = getEffectiveOutputTokens(options)
  const maxImageCount = normalizeLimit(options.maxImageCount, DEFAULT_MAX_IMAGE_COUNT)
  const maxImageBytes = normalizeLimit(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
  const originalImages = countOriginalImages(envelope)
  const trustedChars = getTrustedChars(envelope)
  const schemaChars = getSchemaChars(options.schema)

  let maxInputChars = configuredLimit === undefined ? taskLimit : Math.min(taskLimit, configuredLimit)
  if (options.provider?.contextWindow !== undefined && options.provider.contextWindow > 0) {
    const contextInputChars = Math.max(
      0,
      (Math.max(0, Math.floor(options.provider.contextWindow) - maxOutputTokens) * ESTIMATED_CHARS_PER_TOKEN)
        - trustedChars
        - schemaChars,
    )
    maxInputChars = Math.min(maxInputChars, contextInputChars)
  }

  let remainingTextChars = maxInputChars
  let keptImageCount = 0
  let keptImageBytes = 0
  let droppedImageCount = 0
  let originalChars = 0
  let keptChars = 0
  let truncated = false

  const budgetMessage = (message: LLMMessage): LLMMessage => {
    const isSystemMessage = message.role === 'system'
    if (typeof message.content === 'string') {
      const originalLength = message.content.length
      if (isSystemMessage) return message
      originalChars += originalLength
      const next = truncateTextPreservingBoundary(message.content, remainingTextChars)
      remainingTextChars = Math.max(0, remainingTextChars - next.length)
      keptChars += next.length
      if (next.length < originalLength) truncated = true
      return { ...message, content: next }
    }

    const content = message.content.flatMap((part) => {
      if (part.type === 'image_url') {
        const url = imageUrlFromPart(part)
        const bytes = url ? estimateImageBytes(url) : 0
        if (!url || keptImageCount >= maxImageCount || keptImageBytes + bytes > maxImageBytes) {
          droppedImageCount += 1
          truncated = true
          return []
        }
        keptImageCount += 1
        keptImageBytes += bytes
        return [part]
      }
      if (part.type !== 'text' || typeof part.text !== 'string' || isSystemMessage) return [part]

      originalChars += part.text.length
      const nextText = truncateTextPreservingBoundary(part.text, remainingTextChars)
      remainingTextChars = Math.max(0, remainingTextChars - nextText.length)
      keptChars += nextText.length
      if (nextText.length < part.text.length) truncated = true
      return [{ ...part, text: nextText }]
    })

    return { ...message, content }
  }

  const messages = envelope.messages.map(budgetMessage)
  const estimatedInputTokens = Math.ceil((trustedChars + schemaChars + keptChars) / ESTIMATED_CHARS_PER_TOKEN)

  return {
    envelope: { ...envelope, messages },
    metadata: {
      originalChars: originalChars + trustedChars,
      keptChars: keptChars + trustedChars,
      truncated,
      estimatedInputTokens,
      maxInputChars,
      maxOutputTokens,
      contextWindow: options.provider?.contextWindow,
      originalImageCount: originalImages.count,
      keptImageCount,
      droppedImageCount,
      originalImageBytes: originalImages.bytes,
      keptImageBytes,
      maxImageCount,
      maxImageBytes,
    },
  }
}

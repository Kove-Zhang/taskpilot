import type { CompletionUsage, CostProfile } from './types'

export type CostUnknownReason =
  | 'usage_unavailable'
  | 'input_usage_unavailable'
  | 'output_usage_unavailable'
  | 'input_price_unconfigured'
  | 'output_price_unconfigured'
  | 'image_price_unconfigured'

export interface UsageCostEstimate {
  status: 'known' | 'unknown'
  usage?: CompletionUsage
  estimatedCost?: number
  currency?: string
  inputCost?: number
  outputCost?: number
  imageCost?: number
  billableOutputTokens?: number
  unknownReasons: CostUnknownReason[]
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000
}

/** Normalizes provider-specific usage without inventing missing token counts. */
export function normalizeCompletionUsage(value: unknown): CompletionUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const inputTokens = finiteNonNegativeInteger(record.inputTokens)
  const outputTokens = finiteNonNegativeInteger(record.outputTokens)
  const reasoningTokens = finiteNonNegativeInteger(record.reasoningTokens)
  if (inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined) return undefined
  return { inputTokens, outputTokens, reasoningTokens }
}

/**
 * Estimates one completion's cost. A missing usage field or missing price makes
 * the total explicitly unknown; the function never substitutes a model's market
 * price or treats an absent token count as zero.
 */
export function estimateUsageCost(
  usageValue: CompletionUsage | unknown,
  costProfile: CostProfile | undefined,
  imageCount = 0,
): UsageCostEstimate {
  const usage = normalizeCompletionUsage(usageValue)
  const unknownReasons: CostUnknownReason[] = []
  const normalizedImageCount = finiteNonNegativeInteger(imageCount) ?? 0
  if (!usage) {
    return { status: 'unknown', usage: undefined, unknownReasons: ['usage_unavailable'] }
  }

  const inputTokens = finiteNonNegativeInteger(usage.inputTokens)
  const outputTokens = finiteNonNegativeInteger(usage.outputTokens)
  // Some providers report reasoning separately and omit completion_tokens.
  const billableOutputTokens = outputTokens ?? finiteNonNegativeInteger(usage.reasoningTokens)
  const inputRate = finiteNonNegativeNumber(costProfile?.inputPerMillionTokens)
  const outputRate = finiteNonNegativeNumber(costProfile?.outputPerMillionTokens)
  const imageRate = finiteNonNegativeNumber(costProfile?.imagePerRequest)

  if (inputTokens === undefined) unknownReasons.push('input_usage_unavailable')
  if (billableOutputTokens === undefined) unknownReasons.push('output_usage_unavailable')
  if (inputTokens !== undefined && inputRate === undefined) unknownReasons.push('input_price_unconfigured')
  if (billableOutputTokens !== undefined && outputRate === undefined) unknownReasons.push('output_price_unconfigured')
  if (normalizedImageCount > 0 && imageRate === undefined) unknownReasons.push('image_price_unconfigured')

  const inputCost = inputTokens !== undefined && inputRate !== undefined
    ? roundCost((inputTokens / 1_000_000) * inputRate)
    : undefined
  const outputCost = billableOutputTokens !== undefined && outputRate !== undefined
    ? roundCost((billableOutputTokens / 1_000_000) * outputRate)
    : undefined
  const imageCost = normalizedImageCount > 0 && imageRate !== undefined ? roundCost(imageRate) : undefined

  if (unknownReasons.length > 0) {
    return {
      status: 'unknown',
      usage,
      inputCost,
      outputCost,
      imageCost,
      billableOutputTokens,
      currency: costProfile?.currency?.trim() || undefined,
      unknownReasons: [...new Set(unknownReasons)],
    }
  }

  return {
    status: 'known',
    usage,
    estimatedCost: roundCost((inputCost ?? 0) + (outputCost ?? 0) + (imageCost ?? 0)),
    inputCost,
    outputCost,
    imageCost,
    billableOutputTokens,
    currency: costProfile?.currency?.trim() || undefined,
    unknownReasons: [],
  }
}

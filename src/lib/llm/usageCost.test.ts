import { describe, expect, it } from 'vitest'
import { estimateUsageCost, normalizeCompletionUsage } from './usageCost'

describe('usage and cost estimation', () => {
  it('normalizes valid usage and ignores invalid or negative counts', () => {
    expect(normalizeCompletionUsage({ inputTokens: 12.8, outputTokens: -1, reasoningTokens: 3 })).toEqual({
      inputTokens: 12,
      outputTokens: undefined,
      reasoningTokens: 3,
    })
    expect(normalizeCompletionUsage({ inputTokens: '12' })).toBeUndefined()
  })

  it('calculates input, output and one image request cost using per-million rates', () => {
    const result = estimateUsageCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 20_000 },
      { inputPerMillionTokens: 2, outputPerMillionTokens: 4, imagePerRequest: 0.01, currency: 'USD' },
      2,
    )

    expect(result).toMatchObject({
      status: 'known',
      estimatedCost: 4.01,
      inputCost: 2,
      outputCost: 2,
      imageCost: 0.01,
      billableOutputTokens: 500_000,
      currency: 'USD',
      unknownReasons: [],
    })
  })

  it('uses reasoning tokens as output only when completion output is absent', () => {
    const result = estimateUsageCost(
      { inputTokens: 100, reasoningTokens: 50 },
      { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
    )

    expect(result.status).toBe('known')
    expect(result.billableOutputTokens).toBe(50)
    expect(result.estimatedCost).toBe(0.0002)
  })

  it('reports unknown instead of inventing a price or a missing usage count', () => {
    const noPrice = estimateUsageCost({ inputTokens: 100, outputTokens: 50 }, undefined)
    expect(noPrice.status).toBe('unknown')
    expect(noPrice.estimatedCost).toBeUndefined()
    expect(noPrice.unknownReasons).toEqual(expect.arrayContaining([
      'input_price_unconfigured',
      'output_price_unconfigured',
    ]))

    const noUsage = estimateUsageCost(undefined, { inputPerMillionTokens: 1, outputPerMillionTokens: 2 })
    expect(noUsage).toMatchObject({ status: 'unknown', unknownReasons: ['usage_unavailable'] })
  })

  it('requires an image price when images were sent', () => {
    const result = estimateUsageCost(
      { inputTokens: 10, outputTokens: 10 },
      { inputPerMillionTokens: 1, outputPerMillionTokens: 1 },
      1,
    )

    expect(result.status).toBe('unknown')
    expect(result.unknownReasons).toContain('image_price_unconfigured')
  })
})

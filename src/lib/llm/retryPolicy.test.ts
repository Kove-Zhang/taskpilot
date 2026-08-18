import { describe, expect, it } from 'vitest'
import {
  calculateRetryDelay,
  getRetryAfterMs,
  parseRetryAfterValue,
} from './retryPolicy'

describe('retry policy', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterValue('2', 1_000)).toBe(2_000)
    expect(parseRetryAfterValue('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')))
      .toBe(60_000)
    expect(parseRetryAfterValue('invalid', 1_000)).toBeUndefined()
  })

  it('reads Retry-After before rate-limit reset hints', () => {
    expect(getRetryAfterMs({ 'retry-after': '3', 'x-ratelimit-reset': '9999999999' }, 1_000)).toBe(3_000)
    expect(getRetryAfterMs({ 'retry-after-ms': '250' }, 1_000)).toBe(250)
    expect(getRetryAfterMs({ 'x-ratelimit-reset': '2' }, 1_000)).toBe(1_000)
  })

  it('uses exponential equal-jitter backoff and never shortens a server delay', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0.5 }
    expect(calculateRetryDelay(1, policy, undefined, () => 0)).toBe(500)
    expect(calculateRetryDelay(2, policy, undefined, () => 1)).toBe(2_000)
    expect(calculateRetryDelay(5, policy, 60_000, () => 0)).toBe(60_000)
  })
})

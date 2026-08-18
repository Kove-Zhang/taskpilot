import { describe, expect, it } from 'vitest'
import {
  buildReleaseBaseline,
  buildReleaseBaselineReport,
  formatReleaseBaselineJson,
  formatReleaseBaselineMarkdown,
} from './releaseBaseline'
import type { RedactedLLMCallEvent } from './llm/events'

const event = (overrides: Partial<RedactedLLMCallEvent> & Record<string, unknown> = {}): RedactedLLMCallEvent => ({
  traceId: 'trace', requestId: 'request', taskType: 'todo-extraction', providerId: 'p', providerName: 'P', model: 'm',
  attempt: 1, routeDecision: 'selected', eventStatus: 'success', startedAt: 0, durationMs: 10, ...overrides,
})

describe('release baseline', () => {
  it('aggregates success, latency, cancellation, retry-after, failover, cost and repair metrics', () => {
    const baseline = buildReleaseBaseline([
      event({ durationMs: 10, costStatus: 'known', estimatedCost: 0.1 }),
      event({ durationMs: 50, costStatus: 'unknown', fallbackFrom: 'previous-provider' }),
      event({ eventStatus: 'failure', errorClass: 'rate_limited', retryAfterMs: 3000 }),
      event({ taskType: 'schema-repair', errorClass: 'cancelled' }),
    ])
    expect(baseline).toMatchObject({
      eventCount: 4, selectedCalls: 4, successes: 3, failures: 1, successRate: 75,
      p50LatencyMs: 10, p95LatencyMs: 50, retryAfterCount: 1, cancellationCount: 1,
      failoverCount: 1, knownCostRatio: 50, schemaRepairCalls: 1, schemaRepairRate: 25,
    })
  })

  it('exports a bounded window with provider-model aggregates and no event-level secrets', () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0)
    const report = buildReleaseBaselineReport([
      event({ startedAt: now - 60_000, providerId: 'first', providerName: 'First', model: 'model-a', durationMs: 20, costStatus: 'known', estimatedCost: 0.1 }),
      event({ startedAt: now - 30_000, providerId: 'second', providerName: 'Second', model: 'model-b', eventStatus: 'failure', errorClass: 'rate_limited', retryAfterMs: 2_000, prompt: 'private prompt', apiKey: 'private-key', headers: { authorization: 'Bearer private-key' } }),
      event({ startedAt: now - 25 * 60 * 60 * 1_000, providerId: 'old', providerName: 'Old', model: 'old-model', prompt: 'too old' }),
    ], { generatedAt: now, windowHours: 24 })

    expect(report).toMatchObject({
      window: { hours: 24, end: '2026-08-16T12:00:00.000Z' },
      sampleCount: 2,
      metrics: { eventCount: 2, successes: 1, failures: 1, successRate: 50, retryAfterCount: 1 },
    })
    expect(report.providerModels).toHaveLength(2)
    expect(report.providerModels.map((item) => [item.providerName, item.model])).toEqual([['First', 'model-a'], ['Second', 'model-b']])

    const markdown = formatReleaseBaselineMarkdown(report)
    const json = formatReleaseBaselineJson(report)
    expect(markdown).toContain('Provider + Model 明细')
    expect(json).toContain('"sampleCount": 2')
    for (const forbidden of ['private prompt', 'private-key', 'authorization', 'traceId', 'requestId', 'headers']) {
      expect(markdown).not.toContain(forbidden)
      expect(json).not.toContain(forbidden)
    }
  })

  it('uses N/A rather than fabricated zero rates for a zero-sample window', () => {
    const report = buildReleaseBaselineReport([], { generatedAt: Date.UTC(2026, 7, 16), windowHours: 24 })
    expect(report.metrics).toMatchObject({ successRate: null, p50LatencyMs: null, p95LatencyMs: null, knownCostRatio: null, schemaRepairRate: null })
    expect(formatReleaseBaselineMarkdown(report)).toContain('| N/A | N/A | 0 | N/A | N/A / N/A |')
  })
})

import type { RedactedLLMCallEvent } from './llm/events'

export const RELEASE_BASELINE_SCHEMA_VERSION = 'task-pilot-release-baseline-v1'

export type ReleaseBaselineFormat = 'markdown' | 'json'

export interface ReleaseBaseline {
  eventCount: number
  selectedCalls: number
  successes: number
  failures: number
  successRate?: number
  p50LatencyMs?: number
  p95LatencyMs?: number
  retryAfterCount: number
  cancellationCount: number
  failoverCount: number
  knownCostCalls: number
  unknownCostCalls: number
  knownCostRatio?: number
  schemaRepairCalls: number
  schemaRepairRate?: number
}

export interface ReleaseBaselineMetricSnapshot {
  eventCount: number
  selectedCalls: number
  successes: number
  failures: number
  successRate: number | null
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  retryAfterCount: number
  cancellationCount: number
  failoverCount: number
  knownCostCalls: number
  unknownCostCalls: number
  knownCostRatio: number | null
  schemaRepairCalls: number
  schemaRepairRate: number | null
}

export interface ProviderModelReleaseBaseline {
  providerId: string
  providerName: string
  model: string
  providerInstanceKey?: string
  metrics: ReleaseBaselineMetricSnapshot
}

export interface ReleaseBaselineReport {
  schemaVersion: typeof RELEASE_BASELINE_SCHEMA_VERSION
  generatedAt: string
  window: {
    start: string
    end: string
    hours: number
  }
  sampleCount: number
  metrics: ReleaseBaselineMetricSnapshot
  providerModels: ProviderModelReleaseBaseline[]
}

export interface ReleaseBaselineBuildOptions {
  /** Bounded rolling window; events outside it are intentionally omitted. */
  windowHours?: number
  /** Injectable for deterministic exports/tests. Defaults to the current time. */
  generatedAt?: number
}

function percentile(values: number[], ratio: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function roundPercent(value: number): number {
  return Math.round(value * 10_000) / 100
}

/** Computes only redacted operational metrics suitable for a release gate report. */
export function buildReleaseBaseline(events: readonly RedactedLLMCallEvent[]): ReleaseBaseline {
  const selected = events.filter((event) => event.routeDecision === 'selected')
  const successes = selected.filter((event) => event.eventStatus === 'success')
  const failures = selected.filter((event) => event.eventStatus === 'failure')
  const knownCostCalls = successes.filter((event) => event.costStatus === 'known' && event.estimatedCost !== undefined).length
  const unknownCostCalls = successes.filter((event) => event.costStatus === 'unknown').length
  const schemaRepairCalls = events.filter((event) => event.taskType === 'schema-repair').length
  return {
    eventCount: events.length,
    selectedCalls: selected.length,
    successes: successes.length,
    failures: failures.length,
    successRate: selected.length > 0 ? roundPercent(successes.length / selected.length) : undefined,
    p50LatencyMs: percentile(successes.map((event) => event.durationMs), 0.5),
    p95LatencyMs: percentile(successes.map((event) => event.durationMs), 0.95),
    retryAfterCount: failures.filter((event) => event.retryAfterMs !== undefined).length,
    cancellationCount: events.filter((event) => event.errorClass === 'cancelled').length,
    failoverCount: selected.filter((event) => Boolean(event.fallbackFrom)).length,
    knownCostCalls,
    unknownCostCalls,
    knownCostRatio: knownCostCalls + unknownCostCalls > 0
      ? roundPercent(knownCostCalls / (knownCostCalls + unknownCostCalls))
      : undefined,
    schemaRepairCalls,
    schemaRepairRate: selected.length > 0 ? roundPercent(schemaRepairCalls / selected.length) : undefined,
  }
}

function toMetricSnapshot(baseline: ReleaseBaseline): ReleaseBaselineMetricSnapshot {
  return {
    ...baseline,
    successRate: baseline.successRate ?? null,
    p50LatencyMs: baseline.p50LatencyMs ?? null,
    p95LatencyMs: baseline.p95LatencyMs ?? null,
    knownCostRatio: baseline.knownCostRatio ?? null,
    schemaRepairRate: baseline.schemaRepairRate ?? null,
  }
}

function normalizeWindowHours(value: number | undefined): number {
  if (!Number.isFinite(value)) return 24
  return Math.max(1, Math.min(24 * 31, Math.floor(value as number)))
}

function providerModelGroupKey(event: RedactedLLMCallEvent): string {
  return event.providerInstanceKey ?? `${event.providerId}\u0000${event.providerName}\u0000${event.model}`
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/[|\r\n]/g, ' ').trim() || '未命名'
}

function displayMetric(value: number | null, suffix = ''): string {
  return value === null ? 'N/A' : `${value}${suffix}`
}

/**
 * Aggregates an immutable in-memory event snapshot. It deliberately uses only
 * the RedactedLLMCallEvent allowlist and never serializes event-level data.
 */
export function buildReleaseBaselineReport(
  events: readonly RedactedLLMCallEvent[],
  options: ReleaseBaselineBuildOptions = {},
): ReleaseBaselineReport {
  const generatedAtMs = Number.isFinite(options.generatedAt) ? Math.floor(options.generatedAt as number) : Date.now()
  const windowHours = normalizeWindowHours(options.windowHours)
  const windowStartMs = generatedAtMs - windowHours * 60 * 60 * 1_000
  const windowEvents = events.filter((event) => event.startedAt >= windowStartMs && event.startedAt <= generatedAtMs)
  const groups = new Map<string, RedactedLLMCallEvent[]>()

  for (const event of windowEvents) {
    const key = providerModelGroupKey(event)
    const group = groups.get(key)
    if (group) group.push(event)
    else groups.set(key, [event])
  }

  const providerModels = [...groups.values()]
    .map((group) => {
      const first = group[0]
      return {
        providerId: first.providerId,
        providerName: first.providerName,
        model: first.model,
        ...(first.providerInstanceKey ? { providerInstanceKey: first.providerInstanceKey } : {}),
        metrics: toMetricSnapshot(buildReleaseBaseline(group)),
      }
    })
    .sort((left, right) => `${left.providerName}\u0000${left.model}`.localeCompare(`${right.providerName}\u0000${right.model}`))

  return {
    schemaVersion: RELEASE_BASELINE_SCHEMA_VERSION,
    generatedAt: new Date(generatedAtMs).toISOString(),
    window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(generatedAtMs).toISOString(),
      hours: windowHours,
    },
    sampleCount: windowEvents.length,
    metrics: toMetricSnapshot(buildReleaseBaseline(windowEvents)),
    providerModels,
  }
}

/** Renders N/A for empty samples instead of inventing zero success/cost values. */
export function formatReleaseBaselineMarkdown(report: ReleaseBaselineReport): string {
  const metrics = report.metrics
  const lines = [
    '# TaskPilot 脱敏发布基线',
    '',
    `- 报告版本：${report.schemaVersion}`,
    `- 生成时间：${report.generatedAt}`,
    `- 时间窗口：${report.window.start} ～ ${report.window.end}（${report.window.hours} 小时）`,
    `- 样本量：${report.sampleCount}`,
    '',
    '## 总体指标',
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    `| 已选调用 | ${metrics.selectedCalls} |`,
    `| 成功 / 失败 | ${metrics.successes} / ${metrics.failures} |`,
    `| 成功率 | ${displayMetric(metrics.successRate, '%')} |`,
    `| P50 / P95 延迟 | ${displayMetric(metrics.p50LatencyMs, ' ms')} / ${displayMetric(metrics.p95LatencyMs, ' ms')} |`,
    `| Retry-After | ${metrics.retryAfterCount} |`,
    `| 取消 | ${metrics.cancellationCount} |`,
    `| Failover | ${metrics.failoverCount} |`,
    `| Schema Repair | ${metrics.schemaRepairCalls}（${displayMetric(metrics.schemaRepairRate, '%')}） |`,
    `| 已知 / 未知成本 | ${metrics.knownCostCalls} / ${metrics.unknownCostCalls}（已知率 ${displayMetric(metrics.knownCostRatio, '%')}） |`,
    '',
    '## Provider + Model 明细',
    '',
    '| Provider | Model | 样本 | 成功率 | P50 / P95 | Retry-After | 取消 | Failover | Schema Repair | 已知 / 未知成本 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]

  if (report.providerModels.length === 0) {
    lines.push('| N/A | N/A | 0 | N/A | N/A / N/A | 0 | 0 | 0 | 0 | 0 / 0 |')
  } else {
    for (const item of report.providerModels) {
      const value = item.metrics
      lines.push(`| ${escapeMarkdownCell(item.providerName)} | ${escapeMarkdownCell(item.model)} | ${value.eventCount} | ${displayMetric(value.successRate, '%')} | ${displayMetric(value.p50LatencyMs, ' ms')} / ${displayMetric(value.p95LatencyMs, ' ms')} | ${value.retryAfterCount} | ${value.cancellationCount} | ${value.failoverCount} | ${value.schemaRepairCalls} | ${value.knownCostCalls} / ${value.unknownCostCalls} |`)
    }
  }

  lines.push('', '> 本报告只包含脱敏的聚合指标；不包含 API Key、Header、Prompt、邮件正文、原始响应或请求关联标识。', '')
  return lines.join('\n')
}

export function formatReleaseBaselineJson(report: ReleaseBaselineReport): string {
  return JSON.stringify(report, null, 2) + '\n'
}

export function formatReleaseBaselineReport(report: ReleaseBaselineReport, format: ReleaseBaselineFormat): string {
  return format === 'json' ? formatReleaseBaselineJson(report) : formatReleaseBaselineMarkdown(report)
}

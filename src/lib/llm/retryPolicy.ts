import { createCancellationError, throwIfAborted } from '../http'

export interface RetryBackoffPolicy {
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio?: number
}

export const DEFAULT_RETRY_BACKOFF_POLICY: RetryBackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.5,
}

export interface RetryAfterHeaders {
  get(name: string): string | null
}

function getHeader(headers: RetryAfterHeaders | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const target = name.toLowerCase()
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target)
  return entry?.[1]
}

/** Parses Retry-After seconds or an HTTP date into a non-negative delay. */
export function parseRetryAfterValue(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(Number(trimmed) * 1_000))
  }

  const timestamp = Date.parse(trimmed)
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - nowMs)
  return undefined
}

/**
 * Reads rate-limit hints without trusting them as exact scheduling commands.
 * Retry-After takes precedence; x-ratelimit-reset is interpreted as an epoch
 * timestamp in seconds when present.
 */
export function getRetryAfterMs(
  headers: RetryAfterHeaders | Record<string, string> | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const retryAfter = parseRetryAfterValue(getHeader(headers, 'retry-after'), nowMs)
  if (retryAfter !== undefined) return retryAfter

  const retryAfterMs = getHeader(headers, 'retry-after-ms')
  if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs.trim())) {
    return Math.max(0, Math.ceil(Number(retryAfterMs) * 1))
  }

  const reset = getHeader(headers, 'x-ratelimit-reset')
  if (reset && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
    const numeric = Number(reset)
    const resetMs = numeric > 10_000_000_000 ? numeric : numeric * 1_000
    return Math.max(0, Math.ceil(resetMs - nowMs))
  }

  return undefined
}

/**
 * Equal-jitter exponential backoff. A server-provided Retry-After is always
 * respected as the minimum delay and the result is bounded by maxDelayMs.
 */
export function calculateRetryDelay(
  attempt: number,
  policy: RetryBackoffPolicy = DEFAULT_RETRY_BACKOFF_POLICY,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const baseDelayMs = Math.max(0, policy.baseDelayMs)
  const maxDelayMs = Math.max(baseDelayMs, policy.maxDelayMs)
  const exponent = Math.min(maxDelayMs, baseDelayMs * (2 ** (safeAttempt - 1)))
  const jitterRatio = Math.min(1, Math.max(0, policy.jitterRatio ?? 0.5))
  const jitterFloor = exponent * (1 - jitterRatio)
  const jitterRange = exponent * jitterRatio
  const randomValue = Math.min(1, Math.max(0, random()))
  const jittered = Math.ceil(jitterFloor + jitterRange * randomValue)
  const serverDelay = retryAfterMs === undefined ? 0 : Math.max(0, retryAfterMs)
  return serverDelay > maxDelayMs ? serverDelay : Math.min(maxDelayMs, Math.max(jittered, serverDelay))
}

export function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: number | undefined
    const onAbort = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createCancellationError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
  })
}

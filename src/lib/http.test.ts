import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  isRetryableHttpStatus,
  isRetryableTransportError,
} from './http'

describe('HTTP request helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(fetch).mockReset()
  })

  it('uses the documented default timeout and clears the timer after success', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)

    await expect(fetchWithTimeout('https://example.test')).resolves.toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('converts an aborted request into a timeout error', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    const pending = fetchWithTimeout('https://example.test', {}, 25)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'HttpRequestError', isTimeout: true })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('identifies only transient HTTP and transport failures as retryable', () => {
    expect(isRetryableHttpStatus(408)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableTransportError(new TypeError('network unavailable'))).toBe(true)
    expect(isRetryableTransportError(new Error('invalid request payload'))).toBe(false)
  })
})

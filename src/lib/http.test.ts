import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LLM_REQUEST_TIMEOUT_MS,
  HttpRequestError,
  fetchWithTimeout,
  isRetryableHttpStatus,
  isRetryableRequestError,
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
    expect(LLM_REQUEST_TIMEOUT_MS).toBe(180_000)
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
    expect(isRetryableHttpStatus(409)).toBe(true)
    expect(isRetryableHttpStatus(425)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableTransportError(new TypeError('network unavailable'))).toBe(true)
    expect(isRetryableTransportError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isRetryableTransportError(new Error('无法解析自定义供应商域名'))).toBe(true)
    expect(isRetryableTransportError(new Error('TLS certificate handshake failure'))).toBe(true)
    expect(isRetryableTransportError(new Error('error sending request for url (https://provider.example/v1/chat/completions)'))).toBe(true)
    expect(isRetryableTransportError(new Error('failed to send the request to upstream provider'))).toBe(true)
    expect(isRetryableRequestError(new Error('error while sending request'))).toBe(true)
    expect(isRetryableTransportError(new HttpRequestError('成功响应不是有效 JSON', { isRetryable: true }))).toBe(true)
    expect(isRetryableTransportError(new Error('invalid request payload'))).toBe(false)
    expect(isRetryableRequestError(new HttpRequestError('provider unavailable', { status: 503 }))).toBe(true)
    expect(isRetryableRequestError(new HttpRequestError('invalid request', { status: 400 }))).toBe(false)
    expect(isRetryableRequestError(new HttpRequestError('authentication failed', { status: 401 }))).toBe(false)
  })
})

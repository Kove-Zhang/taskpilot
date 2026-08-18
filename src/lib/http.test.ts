import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LLM_REQUEST_TIMEOUT_MS,
  HttpRequestError,
  fetchWithTimeout,
  isCancellationError,
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

  it('preserves native Response metadata while wrapping the body lifecycle', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const response = await fetchWithTimeout('https://example.test')

    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({ ok: true })
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
  it('distinguishes external cancellation from a timeout and does not classify it as retryable', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    const pending = fetchWithTimeout('https://example.test', {}, 1_000, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'HttpRequestError', isCancelled: true, isTimeout: false })
    await expect(pending).rejects.not.toMatchObject({ isRetryable: true })
    expect(isCancellationError(new HttpRequestError('cancelled', { isCancelled: true }))).toBe(true)
  })

  it('reports the timeout phase for layered policies and keeps total timeout alive while reading the body', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    const pending = fetchWithTimeout('https://example.test', {}, {
      connectTimeoutMs: 25,
      firstByteTimeoutMs: 60,
      totalTimeoutMs: 100,
    })
    const assertion = expect(pending).rejects.toMatchObject({ isTimeout: true, timeoutPhase: 'connect' })
    await vi.advanceTimersByTimeAsync(25)
    await assertion

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => new Promise(() => { /* body never completes */ }),
    } as Response)
    const response = await fetchWithTimeout('https://example.test', {}, {
      connectTimeoutMs: 25,
      firstByteTimeoutMs: 60,
      totalTimeoutMs: 100,
    })
    const bodyPending = response.json()
    const bodyAssertion = expect(bodyPending).rejects.toMatchObject({ isTimeout: true })
    await vi.advanceTimersByTimeAsync(100)
    await bodyAssertion
  })

})

import { describe, expect, it } from 'vitest'
import {
  EMAIL_HISTORY_HTML_PREVIEW_LIMIT,
  EMAIL_HISTORY_TEXT_PREVIEW_LIMIT,
  limitEmailHistoryHtml,
  limitEmailHistoryText,
} from './emailHistoryContent'

describe('email history content limits', () => {
  it('keeps complete content within the local history preview budget', () => {
    expect(limitEmailHistoryText('正常邮件正文')).toBe('正常邮件正文')
    expect(limitEmailHistoryHtml('<p>正常邮件正文</p>')).toBe('<p>正常邮件正文</p>')
  })

  it('stores a bounded text preview with a visible truncation notice', () => {
    const result = limitEmailHistoryText('a'.repeat(EMAIL_HISTORY_TEXT_PREVIEW_LIMIT + 1))

    expect(result).toContain('邮件正文超过')
    expect(result?.length).toBeGreaterThan(EMAIL_HISTORY_TEXT_PREVIEW_LIMIT)
    expect(result?.length).toBeLessThan(EMAIL_HISTORY_TEXT_PREVIEW_LIMIT + 200)
  })

  it('stores a bounded HTML preview with a visible truncation notice', () => {
    const result = limitEmailHistoryHtml('b'.repeat(EMAIL_HISTORY_HTML_PREVIEW_LIMIT + 1))

    expect(result).toContain('邮件 HTML 正文超过')
    expect(result?.length).toBeLessThan(EMAIL_HISTORY_HTML_PREVIEW_LIMIT + 220)
  })
})

import { describe, expect, it } from 'vitest'
import { budgetInputEnvelope, estimateImageBytes } from './contextBudgeter'
import { getTaskProfile } from './taskProfiles'

const task = getTaskProfile('todo-extraction')

describe('context budgeter', () => {
  it('keeps trusted instructions and applies a single shared text budget to user messages', () => {
    const result = budgetInputEnvelope({
      trustedInstructions: ['系统规则'],
      messages: [
        { role: 'system', content: '必须保留的 system 指令' },
        { role: 'user', content: '<untrusted-content source="email">xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</untrusted-content>' },
        { role: 'user', content: '第二段不应突破预算' },
      ],
    }, { task, maxInputChars: 80 })

    expect(result.metadata.truncated).toBe(true)
    expect(result.metadata.maxInputChars).toBe(80)
    expect(result.envelope.messages[0].content).toBe('必须保留的 system 指令')
    const first = result.envelope.messages[1].content as string
    expect(first).toContain('</untrusted-content>')
    expect(first.length).toBeLessThanOrEqual(80)
    expect((result.envelope.messages[2].content as string).length).toBe(0)
    expect(result.metadata.estimatedInputTokens).toBeGreaterThan(0)
  })

  it('reserves output and schema space when a provider context window is small', () => {
    const result = budgetInputEnvelope({
      trustedInstructions: ['系统规则'],
      messages: [{ role: 'user', content: 'x'.repeat(500) }],
    }, {
      task: { maxInputChars: 500, maxOutputTokens: 20 },
      provider: { contextWindow: 100, maxOutputTokens: 30 },
      schema: { properties: { summary: { type: 'string' } } },
    })

    expect(result.metadata.maxOutputTokens).toBe(20)
    expect(result.metadata.maxInputChars).toBeLessThan(500)
    expect((result.envelope.messages[0].content as string).length).toBe(result.metadata.keptChars - '系统规则'.length)
  })

  it('drops images over count or byte budgets and reports the decision without logging image data', () => {
    const small = 'data:image/png;base64,' + 'a'.repeat(16)
    const large = 'data:image/png;base64,' + 'b'.repeat(80)
    const result = budgetInputEnvelope({
      trustedInstructions: [],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '正文' },
          { type: 'image_url', image_url: { url: small } },
          { type: 'image_url', image_url: { url: large } },
        ],
      }],
    }, {
      task,
      maxImageCount: 1,
      maxImageBytes: estimateImageBytes(small),
    })

    expect(result.metadata.originalImageCount).toBe(2)
    expect(result.metadata.keptImageCount).toBe(1)
    expect(result.metadata.droppedImageCount).toBe(1)
    expect(result.metadata.truncated).toBe(true)
    expect(result.envelope.messages[0].content).toHaveLength(2)
  })

  it('uses the stricter of task, user and provider limits', () => {
    const result = budgetInputEnvelope({
      trustedInstructions: [],
      messages: [{ role: 'user', content: 'x'.repeat(100) }],
    }, {
      task: { maxInputChars: 80, maxOutputTokens: 10 },
      maxInputChars: 60,
      provider: { contextWindow: 50, maxOutputTokens: 10 },
    })

    expect(result.metadata.maxInputChars).toBe(60)
    expect((result.envelope.messages[0].content as string).length).toBeLessThanOrEqual(60)
  })
})

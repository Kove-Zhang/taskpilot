import { describe, expect, it } from 'vitest'
import { ClassifiedLLMError } from './errors'
import { createFallbackTodoId, validateTodoExtractionResponse } from './responseValidator'

describe('todo response validator', () => {
  it('recovers fenced JSON and normalizes aliases and missing IDs', () => {
    const result = validateTodoExtractionResponse(`\`\`\`json
{"summary":"  摘要 ","key_points":["要点"],"todos":[{"task":"整理报告","priority":"High","planned_date":null}]}
\`\`\``)

    expect(result.summary).toBe('  摘要 ')
    expect(result.key_points).toEqual(['要点'])
    expect(result.todos[0]).toMatchObject({ title: '整理报告', priority: 'High', planned_date: null, selected: true })
    expect(result.todos[0].id).toBe(createFallbackTodoId(`\`\`\`json
{"summary":"  摘要 ","key_points":["要点"],"todos":[{"task":"整理报告","priority":"High","planned_date":null}]}
\`\`\``, 0, '整理报告'))
    expect(result.originalTodos).not.toBe(result.todos)
  })

  it('raises invalid_response for malformed JSON and schema_invalid for contract errors', () => {
    expect(() => validateTodoExtractionResponse('{not-json}')).toThrowError(ClassifiedLLMError)
    try {
      validateTodoExtractionResponse('{not-json}')
    } catch (error) {
      expect(error).toMatchObject({ errorClass: 'invalid_response' })
    }

    expect(() => validateTodoExtractionResponse(JSON.stringify({ summary: 'x', todos: [{ title: 'same', priority: 'High', planned_date: null, id: 'dup' }, { title: 'same2', priority: 'High', planned_date: '2026-02-30', id: 'dup' }] }))).toThrowError(ClassifiedLLMError)
    try {
      validateTodoExtractionResponse(JSON.stringify({ summary: 'x', todos: [{ title: 'same', priority: 'High', planned_date: null, id: 'dup' }, { title: 'same2', priority: 'High', planned_date: '2026-02-30', id: 'dup' }] }))
    } catch (error) {
      expect(error).toMatchObject({ errorClass: 'schema_invalid' })
      expect((error as ClassifiedLLMError).cause).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'todos[1].id' }),
        expect.objectContaining({ path: 'todos[1].planned_date' }),
      ]))
    }
  })

  it('validates typed dynamic Notion fields and preserves compatible fields', () => {
    const result = validateTodoExtractionResponse(JSON.stringify({
      summary: 'summary',
      todos: [{
        '事项名称': '准备演示',
        priority: '★★★',
        planned_date: '2026-08-06',
        状态: '待处理',
        标签: ['客户'],
        已完成: false,
        分数: 4,
      }],
    }), {
      notionProperties: [
        { id: 'title', name: '事项名称', type: 'title' },
        { id: 'status', name: '状态', type: 'select', options: ['待处理'] },
        { id: 'labels', name: '标签', type: 'multi_select', options: ['客户'] },
        { id: 'done', name: '已完成', type: 'checkbox' },
        { id: 'score', name: '分数', type: 'number' },
      ],
      fieldMappings: {
        title: { notionPropId: 'title', enabled: true, aiHint: '', order: 0 },
        status: { notionPropId: 'status', enabled: true, aiHint: '', order: 1 },
        labels: { notionPropId: 'labels', enabled: true, aiHint: '', order: 2 },
        done: { notionPropId: 'done', enabled: true, aiHint: '', order: 3 },
        score: { notionPropId: 'score', enabled: true, aiHint: '', order: 4 },
      },
    })

    expect(result.todos[0]).toMatchObject({ title: '准备演示', 状态: '待处理', 标签: ['客户'], 已完成: false, 分数: 4 })
  })
})

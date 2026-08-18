import { describe, expect, it } from 'vitest'
import { buildTodoOutputSchema, buildTodoPromptContract } from './todoSchema'

describe('todo output schema', () => {
  it('builds required core fields and typed Notion properties', () => {
    const schema = buildTodoOutputSchema({
      notionProperties: [
        { id: 'title-prop', name: '事项名称', type: 'title' },
        { id: 'status-prop', name: '状态', type: 'select', options: ['待处理', '完成'] },
        { id: 'labels-prop', name: '标签', type: 'multi_select', options: ['重要', '客户'] },
        { id: 'date-prop', name: '截止日', type: 'date' },
        { id: 'done-prop', name: '已完成', type: 'checkbox' },
        { id: 'score-prop', name: '分数', type: 'number' },
        { id: 'unknown-prop', name: '备注', type: 'url' },
      ],
      fieldMappings: {
        'title-prop': { notionPropId: 'title-prop', enabled: true, aiHint: '', order: 0 },
        'status-prop': { notionPropId: 'status-prop', enabled: true, aiHint: '', order: 1 },
        'labels-prop': { notionPropId: 'labels-prop', enabled: true, aiHint: '', order: 2 },
        'date-prop': { notionPropId: 'date-prop', enabled: true, aiHint: '', order: 3 },
        'done-prop': { notionPropId: 'done-prop', enabled: true, aiHint: '', order: 4 },
        'score-prop': { notionPropId: 'score-prop', enabled: true, aiHint: '', order: 5 },
        'unknown-prop': { notionPropId: 'unknown-prop', enabled: true, aiHint: '', order: 6 },
      },
    })
    const todoSchema = (schema.properties as Record<string, unknown>).todos as Record<string, unknown>
    const itemSchema = todoSchema.items as Record<string, unknown>
    const properties = itemSchema.properties as Record<string, Record<string, unknown>>

    expect(itemSchema.required).toEqual(['id', 'title', 'priority', 'planned_date'])
    expect(properties['事项名称']).toMatchObject({ type: 'string', minLength: 1 })
    expect(properties['状态'].enum).toEqual(['待处理', '完成'])
    expect(properties['标签'].items).toMatchObject({ enum: ['重要', '客户'] })
    expect(properties['截止日'].anyOf).toHaveLength(2)
    expect(properties['已完成']).toMatchObject({ type: 'boolean' })
    expect(properties['分数']).toMatchObject({ type: 'number' })
    expect(properties['备注']).toMatchObject({ type: 'string' })
  })

  it('keeps the provider prompt contract compatible while moving field schema generation out of ai.ts', () => {
    const prompt = buildTodoPromptContract({
      notionProperties: [{ id: 'owner', name: '负责人', type: 'rich_text' }],
      fieldMappings: { owner: { notionPropId: 'owner', enabled: true, aiHint: '优先提取负责人', order: 0 } },
    })

    expect(prompt).toContain('"title": "待办事项标题（非空字符串）"')
    expect(prompt).toContain('"负责人": "字符串"')
    expect(prompt).toContain('优先提取负责人')
  })
})

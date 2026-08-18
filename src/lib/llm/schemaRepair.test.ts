import { describe, expect, it, vi } from 'vitest'
import { buildTodoOutputSchema } from './schemas/todoSchema'
import { createSchemaRepairPlan, repairSchemaOnce } from './schemaRepair'
import type { LLMProvider } from '../../store'

const provider: LLMProvider = {
  id: 'repair-provider',
  name: 'Repair provider',
  apiBaseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelName: 'repair-model',
  enabled: true,
  priority: 1,
}

describe('schema repair', () => {
  it('builds a no-image schema-repair task with the schema and raw JSON only', () => {
    const schema = buildTodoOutputSchema()
    const plan = createSchemaRepairPlan({
      rawContent: '{"summary":"x","todos":[]}',
      schema,
      validationSummary: 'todos[0].title: 缺少有效 title',
    })
    const payload = plan.payloadForProvider(provider)

    expect(plan.task.type).toBe('schema-repair')
    expect(payload.messages.some((message) => message.content.includes('image_url'))).toBe(false)
    expect(payload.messages[1].content).toContain('todos[0].title')
    expect(payload.messages[1].content).toContain(JSON.stringify(schema))
    expect(payload.messages[1].content).toContain('{"summary":"x","todos":[]}')
    expect(payload.response_format.json_schema.schema).toEqual(schema)
  })

  it('invokes the repair callback exactly once', async () => {
    const invoke = vi.fn(async (buildPayload: (provider: LLMProvider) => unknown) => {
      expect(buildPayload(provider)).toMatchObject({ model: 'repair-model' })
      return '{"summary":"fixed","todos":[]}'
    })

    await expect(repairSchemaOnce({
      rawContent: '{}',
      schema: buildTodoOutputSchema(),
      validationSummary: 'summary: 缺少',
    }, invoke)).resolves.toContain('fixed')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

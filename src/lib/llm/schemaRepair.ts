import type { LLMProvider } from '../../store'
import { getTaskProfile } from './taskProfiles'
import type { TaskProfile } from './types'
import type { JsonSchema } from './schemas/todoSchema'

export interface SchemaRepairPayload {
  [key: string]: unknown
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  response_format: {
    type: 'json_schema'
    json_schema: {
      name: string
      strict: true
      schema: JsonSchema
    }
  }
  max_tokens: number
  temperature: number
}

export interface SchemaRepairRequest {
  rawContent: string
  schema: JsonSchema
  validationSummary: string
}

export type SchemaRepairInvoker = (
  buildPayload: (provider: LLMProvider) => SchemaRepairPayload,
  logContextName: string,
) => Promise<string>

export interface SchemaRepairPlan {
  task: TaskProfile
  payloadForProvider(provider: LLMProvider): SchemaRepairPayload
}

/**
 * Creates the one-shot repair request. The caller owns the one-shot boundary:
 * this helper never calls itself and never parses or retries a repair response.
 */
export function createSchemaRepairPlan(request: SchemaRepairRequest): SchemaRepairPlan {
  const task = getTaskProfile('schema-repair')
  const schemaText = JSON.stringify(request.schema)
  const systemPrompt = [
    '你是待办输出 Schema 修复器。',
    '只返回符合给定 JSON Schema 的一个 JSON 对象，不要 Markdown、解释、注释或额外字段。',
    '只修复格式、字段别名、类型和缺失值；不要补充原始内容中不存在的新事实。',
    'todos 没有明确日期时 planned_date 必须为 null；缺少 id 时生成同次输出内唯一的字符串 id。',
  ].join('\n')
  const userPrompt = [
    '【JSON Schema】',
    schemaText,
    '',
    '【校验错误摘要】',
    request.validationSummary,
    '',
    '【原始 JSON 输出】',
    request.rawContent,
  ].join('\n')

  return {
    task,
    payloadForProvider: (provider) => ({
      model: provider.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'task_pilot_schema_repair',
          strict: true,
          schema: request.schema,
        },
      },
      max_tokens: task.maxOutputTokens,
      temperature: task.temperature ?? 0,
    }),
  }
}

/** Runs exactly one repair invocation; no recursive repair or local retry is performed here. */
export async function repairSchemaOnce(
  request: SchemaRepairRequest,
  invoke: SchemaRepairInvoker,
): Promise<string> {
  const plan = createSchemaRepairPlan(request)
  return invoke((provider) => plan.payloadForProvider(provider), 'Schema修复')
}



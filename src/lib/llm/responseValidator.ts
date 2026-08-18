import { ClassifiedLLMError } from './errors'
import {
  DEFAULT_MAX_SUMMARY_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  DEFAULT_MAX_TODOS,
  TODO_DATE_PATTERN,
  TODO_ID_FIELD_ALIASES,
  TODO_PRIORITY_VALUES,
  TODO_TITLE_FIELD_ALIASES,
  getConfiguredTodoTitleFields,
  getEnabledNotionProperties,
  type TodoSchemaOptions,
} from './schemas/todoSchema'
import type { TodoItem } from '../ai'

export interface TodoExtractionResult {
  summary: string
  key_points?: string[]
  todos: TodoItem[]
  originalTodos: TodoItem[]
}

export interface ValidationIssue {
  path: string
  message: string
}

export interface ResponseValidationOptions extends TodoSchemaOptions {
  rawContent?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeFieldNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort().slice(0, 30) : []
}

function nonEmptyText(value: unknown, allowNumber = false): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function findTextField(
  value: Record<string, unknown>,
  fieldNames: readonly string[],
  allowNumber = false,
): { fieldName: string; value: string } | null {
  for (const fieldName of fieldNames) {
    const text = nonEmptyText(value[fieldName], allowNumber)
    if (text) return { fieldName, value: text }
  }
  return null
}

/** Keep the historical generated-id algorithm stable for existing results. */
export function createFallbackTodoId(rawContent: string, index: number, title: string): string {
  const input = `${rawContent}\u0000${index}\u0000${title}`
  let hash = 2_166_136_261
  for (let position = 0; position < input.length; position += 1) {
    hash ^= input.charCodeAt(position)
    hash = Math.imul(hash, 16_777_619)
  }
  return `generated-${index + 1}-${(hash >>> 0).toString(36)}`
}

function parseJsonContent(rawContent: string): unknown {
  const trimmed = rawContent.trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }

  throw new ClassifiedLLMError('invalid_response', 'AI 返回的格式无法解析为 JSON', {
    retryable: false,
    failoverable: false,
    cause: lastError,
  })
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message }
}

function isValidDate(value: string): boolean {
  if (!new RegExp(TODO_DATE_PATTERN).test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validateString(value: unknown, path: string, maxLength: number, required = true): ValidationIssue[] {
  if (typeof value !== 'string') return [issue(path, '必须是字符串')]
  if (required && !value.trim()) return [issue(path, '不能为空')]
  if (value.length > maxLength) return [issue(path, `长度不能超过 ${maxLength}`)]
  return []
}

function validateDynamicField(
  property: { name: string; type: string; options?: string[] },
  value: unknown,
  path: string,
): ValidationIssue[] {
  const options = (property.options ?? []).map((option) => option.trim()).filter(Boolean)
  switch (property.type) {
    case 'title':
    case 'rich_text':
      return validateString(value, path, property.type === 'title' ? DEFAULT_MAX_TITLE_LENGTH : 2_000)
    case 'select':
      if (typeof value !== 'string' || !value.trim()) return [issue(path, '必须是非空字符串')]
      return options.length > 0 && !options.includes(value.trim())
        ? [issue(path, `必须使用已配置选项: ${options.join(', ')}`)]
        : []
    case 'multi_select': {
      if (!Array.isArray(value)) return [issue(path, '必须是字符串数组')]
      const errors: ValidationIssue[] = []
      value.forEach((item, index) => {
        if (typeof item !== 'string' || !item.trim()) errors.push(issue(`${path}[${index}]`, '必须是非空字符串'))
        else if (options.length > 0 && !options.includes(item.trim())) errors.push(issue(`${path}[${index}]`, `不是已配置选项`))
      })
      return errors
    }
    case 'date':
      if (value === null) return []
      return typeof value === 'string' && isValidDate(value) ? [] : [issue(path, '必须是 YYYY-MM-DD 日期或 null')]
    case 'checkbox':
      return typeof value === 'boolean' ? [] : [issue(path, '必须是布尔值')]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [issue(path, '必须是有限数字')]
    default:
      return validateString(value, path, 2_000, false)
  }
}

function normalizeTodo(
  rawTodo: Record<string, unknown>,
  index: number,
  rawContent: string,
  titleFieldNames: readonly string[],
): { todo?: TodoItem; issues: ValidationIssue[] } {
  const path = `todos[${index}]`
  const title = findTextField(rawTodo, titleFieldNames)
  if (!title) return { issues: [issue(`${path}.title`, `缺少有效 title，可兼容字段: ${titleFieldNames.join(', ')}`)] }

  const modelId = findTextField(rawTodo, TODO_ID_FIELD_ALIASES, true)
  const id = modelId?.value || createFallbackTodoId(rawContent, index, title.value)
  const normalized = { ...rawTodo, id, title: title.value, selected: true } as TodoItem
  const issues: ValidationIssue[] = []

  issues.push(...validateString(normalized.id, `${path}.id`, 200))
  issues.push(...validateString(normalized.title, `${path}.title`, DEFAULT_MAX_TITLE_LENGTH))
  if (typeof normalized.priority !== 'string' || !normalized.priority.trim()) {
    issues.push(issue(`${path}.priority`, '必须是非空优先级字符串'))
  } else if (normalized.priority.length > 32) {
    issues.push(issue(`${path}.priority`, '长度不能超过 32'))
  } else if (!(TODO_PRIORITY_VALUES as readonly string[]).includes(normalized.priority) && !/^[^\s]+$/.test(normalized.priority)) {
    issues.push(issue(`${path}.priority`, '优先级格式不受支持'))
  }

  if (!Object.prototype.hasOwnProperty.call(rawTodo, 'planned_date')) {
    issues.push(issue(`${path}.planned_date`, '字段必填；无明确日期时必须为 null'))
  } else if (normalized.planned_date !== null && (typeof normalized.planned_date !== 'string' || !isValidDate(normalized.planned_date))) {
    issues.push(issue(`${path}.planned_date`, '必须是 YYYY-MM-DD 日期或 null'))
  }

  return { todo: normalized, issues }
}

export function validateTodoExtractionResponse(
  rawContent: string,
  options: ResponseValidationOptions = {},
): TodoExtractionResult {
  const parsed = parseJsonContent(rawContent)
  const maxTodos = Math.max(0, Math.min(options.maxTodos ?? DEFAULT_MAX_TODOS, 100))
  const maxSummaryLength = Math.max(1, options.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH)
  const issues: ValidationIssue[] = []

  if (!isRecord(parsed)) {
    issues.push(issue('$', '顶层必须是对象'))
  }

  const root = isRecord(parsed) ? parsed : {}
  issues.push(...validateString(root.summary, 'summary', maxSummaryLength))
  if (!Array.isArray(root.todos)) {
    issues.push(issue('todos', '必须是数组'))
  } else if (root.todos.length > maxTodos) {
    issues.push(issue('todos', `数量不能超过 ${maxTodos}`))
  }

  let keyPoints: string[] | undefined
  if (root.key_points !== undefined) {
    if (!Array.isArray(root.key_points)) {
      issues.push(issue('key_points', '必须是字符串数组'))
    } else {
      keyPoints = []
      root.key_points.forEach((item, index) => {
        const itemIssues = validateString(item, `key_points[${index}]`, 500)
        issues.push(...itemIssues)
        if (typeof item === 'string' && item.trim() && itemIssues.length === 0) keyPoints?.push(item.trim())
      })
      if (root.key_points.length > 20) issues.push(issue('key_points', '数量不能超过 20'))
    }
  }

  const titleFieldNames = [...new Set([...TODO_TITLE_FIELD_ALIASES, ...getConfiguredTodoTitleFields(options)])]
  const todos: TodoItem[] = []
  if (Array.isArray(root.todos)) {
    root.todos.forEach((value, index) => {
      if (!isRecord(value)) {
        issues.push(issue(`todos[${index}]`, '必须是对象'))
        return
      }
      const normalized = normalizeTodo(value, index, rawContent, titleFieldNames)
      issues.push(...normalized.issues)
      if (normalized.todo) todos.push(normalized.todo)

      for (const property of getEnabledNotionProperties(options)) {
        if (!Object.prototype.hasOwnProperty.call(value, property.name)) continue
        issues.push(...validateDynamicField(property, value[property.name], `todos[${index}].${property.name}`))
      }
    })
  }

  const ids = new Set<string>()
  todos.forEach((todo, index) => {
    if (ids.has(todo.id)) issues.push(issue(`todos[${index}].id`, `重复 ID: ${todo.id}`))
    ids.add(todo.id)
  })

  if (issues.length > 0) {
    throw new ClassifiedLLMError('schema_invalid', `AI 返回结果未通过待办输出契约校验: ${issues.slice(0, 5).map((item) => `${item.path} ${item.message}`).join('; ')}`, {
      retryable: false,
      failoverable: false,
      userActionRequired: false,
      cause: issues,
    })
  }

  return {
    summary: root.summary as string,
    key_points: keyPoints,
    todos,
    originalTodos: structuredClone(todos),
  }
}

export function getValidationIssues(error: unknown): ValidationIssue[] {
  if (!(error instanceof ClassifiedLLMError) || error.errorClass !== 'schema_invalid') return []
  return Array.isArray(error.cause) ? error.cause as ValidationIssue[] : [{ path: '$', message: error.message }]
}

export function describeResponseForRepair(rawContent: string, error: unknown): string {
  const issues = getValidationIssues(error)
  const summary = issues.slice(0, 12).map((item) => `${item.path}: ${item.message}`).join('\n')
  return `校验错误:\n${summary || '输出未通过待办 Schema 校验'}\n\n原始输出长度: ${rawContent.length}\n顶层/字段示例仅用于修复，不要添加解释文字。`
}

export function getResponseSafeFieldNames(value: unknown): string[] {
  return safeFieldNames(value)
}

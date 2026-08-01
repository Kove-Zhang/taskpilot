import { fetchWithTimeout, HttpRequestError, isRetryableRequestError } from './http'
import { LazyStore } from '@tauri-apps/plugin-store'
import { useSettingsStore, type NotionProperty } from '../store'
import type { TodoItem } from './ai'
import { notionHeaders, notionPagesEndpoint } from './notionApi'

export interface SyncResult {
  id: string
  success: boolean
  error?: string
  pageId?: string
  skipped?: boolean
  retryable?: boolean
}

type NotionPropertyValue = Record<string, unknown>
type SyncState = 'pending' | 'succeeded' | 'unknown'

interface SyncRecord {
  fingerprint: string
  state: SyncState
  updatedAt: number
  pageId?: string
}

const idempotencyStore = new LazyStore('notion_sync_records.json')
const IDEMPOTENCY_KEY = 'records'
let syncQueue: Promise<void> = Promise.resolve()

function runSequentially<T>(operation: () => Promise<T>): Promise<T> {
  const run = syncQueue.then(operation, operation)
  syncQueue = run.then(() => undefined, () => undefined)
  return run
}

function isSupportedDate(value: unknown): string | null {
  const date = String(value).replace(/\//g, '-').substring(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function valuesFromRelation(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean)
  }
  return String(value).split(',').map((item) => item.trim()).filter(Boolean)
}

function ensureOptionIsAllowed(property: NotionProperty, value: string): void {
  if (property.options && property.options.length > 0 && !property.options.includes(value)) {
    throw new Error(`Notion 字段「${property.name}」不包含选项「${value}」`)
  }
}

function serializeProperty(property: NotionProperty, value: unknown): NotionPropertyValue {
  switch (property.type) {
    case 'title':
      return { title: [{ text: { content: String(value) } }] }
    case 'rich_text':
      return { rich_text: [{ text: { content: String(value) } }] }
    case 'select': {
      const option = String(value).trim()
      ensureOptionIsAllowed(property, option)
      return { select: { name: option } }
    }
    case 'status': {
      const option = String(value).trim()
      ensureOptionIsAllowed(property, option)
      return { status: { name: option } }
    }
    case 'multi_select': {
      const names = Array.isArray(value) ? value.map(String) : String(value).split(',')
      const normalized = names.map((name) => name.trim()).filter(Boolean)
      normalized.forEach((name) => ensureOptionIsAllowed(property, name))
      return { multi_select: normalized.map((name) => ({ name })) }
    }
    case 'date': {
      const date = isSupportedDate(value)
      if (!date) throw new Error(`Notion 日期字段「${property.name}」需要 YYYY-MM-DD 格式`)
      return { date: { start: date } }
    }
    case 'checkbox':
      return { checkbox: value === true || String(value).toLowerCase() === 'true' }
    case 'number': {
      const number = Number(value)
      if (Number.isNaN(number)) throw new Error(`Notion 数字字段「${property.name}」不是有效数字`)
      return { number }
    }
    case 'url':
      return { url: String(value) }
    case 'email':
      return { email: String(value) }
    case 'phone_number':
      return { phone_number: String(value) }
    case 'relation': {
      const ids = valuesFromRelation(value)
      if (ids.length === 0) throw new Error(`Notion 关联字段「${property.name}」缺少页面 ID`)
      return { relation: ids.map((id) => ({ id })) }
    }
    default:
      throw new Error(`Notion 字段「${property.name}」的类型「${property.type}」暂不支持同步`)
  }
}

function serializeFallbackProperty(key: string, value: unknown): NotionPropertyValue | null {
  if (key === 'title' || key === 'Name') {
    return { title: [{ text: { content: String(value) } }] }
  }
  if (key === 'priority' || key === '优先级') {
    return { select: { name: String(value) } }
  }
  if (key === 'planned_date' || key === '计划完成时间') {
    const date = isSupportedDate(value)
    return date ? { date: { start: date } } : null
  }
  return null
}

function buildPageBody(todo: TodoItem): { parent: { type: 'database_id'; database_id: string }; properties: Record<string, NotionPropertyValue> } {
  const { notionDatabaseId, notionProperties, fieldMappings } = useSettingsStore.getState()
  const properties: Record<string, NotionPropertyValue> = {}

  for (const [key, value] of Object.entries(todo)) {
    if (key === 'id' || key === 'selected' || key === 'synced' || value === undefined || value === null || value === '') continue

    const property = notionProperties.find((candidate) => candidate.name === key)
    if (!property) {
      if (notionProperties.length === 0) {
        const fallback = serializeFallbackProperty(key, value)
        if (fallback) properties[key] = fallback
      }
      continue
    }

    if (!fieldMappings[property.id]?.enabled) continue
    properties[property.name] = serializeProperty(property, value)
  }

  if (Object.keys(properties).length === 0) {
    throw new Error('没有可同步的 Notion 字段。请检查字段映射、待办内容和数据库结构。')
  }

  return {
    parent: { type: 'database_id', database_id: notionDatabaseId },
    properties,
  }
}

async function fingerprintPageBody(pageBody: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(pageBody))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readSyncRecords(): Promise<Record<string, SyncRecord>> {
  return (await idempotencyStore.get<Record<string, SyncRecord>>(IDEMPOTENCY_KEY)) || {}
}

async function writeSyncRecords(records: Record<string, SyncRecord>): Promise<void> {
  await idempotencyStore.set(IDEMPOTENCY_KEY, records)
  await idempotencyStore.save()
}

function syncRecordKey(databaseId: string, todoId: string): string {
  return `${databaseId}:${todoId}`
}

async function syncOne(todo: TodoItem): Promise<SyncResult> {
  const { notionApiKey, notionDatabaseId } = useSettingsStore.getState()
  if (!todo.id) return { id: '', success: false, error: '待办缺少本地唯一 ID' }

  const pageBody = buildPageBody(todo)
  const fingerprint = await fingerprintPageBody(pageBody)
  const recordKey = syncRecordKey(notionDatabaseId, todo.id)
  const records = await readSyncRecords()
  const existing = records[recordKey]

  if (existing?.fingerprint === fingerprint && existing.state === 'succeeded') {
    return { id: todo.id, success: true, pageId: existing.pageId, skipped: true }
  }
  if (existing?.fingerprint === fingerprint && (existing.state === 'pending' || existing.state === 'unknown')) {
    return {
      id: todo.id,
      success: false,
      error: '该待办上次同步结果未知，系统已阻止自动重试以避免重复创建 Notion 页面。请先在 Notion 中核对后再处理。',
    }
  }

  records[recordKey] = { fingerprint, state: 'pending', updatedAt: Date.now() }
  await writeSyncRecords(records)

  try {
    const response = await fetchWithTimeout(notionPagesEndpoint(), {
      method: 'POST',
      headers: notionHeaders(notionApiKey, true),
      body: JSON.stringify(pageBody),
    })

    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 1_000)
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        records[recordKey] = { fingerprint, state: 'unknown', updatedAt: Date.now() }
        await writeSyncRecords(records)
      } else {
        delete records[recordKey]
        await writeSyncRecords(records)
      }
      throw new HttpRequestError(`Notion 同步失败 (${response.status}): ${body}`, { status: response.status })
    }

    const responseData: unknown = await response.json()
    if (typeof responseData !== 'object' || responseData === null || !('id' in responseData) || typeof responseData.id !== 'string') {
      records[recordKey] = { fingerprint, state: 'unknown', updatedAt: Date.now() }
      await writeSyncRecords(records)
      throw new Error('Notion 已返回成功状态，但响应中缺少页面 ID；为避免重复创建，系统已将该待办标记为待人工核对。')
    }

    records[recordKey] = { fingerprint, state: 'succeeded', pageId: responseData.id, updatedAt: Date.now() }
    await writeSyncRecords(records)
    return { id: todo.id, success: true, pageId: responseData.id }
  } catch (error) {
    if (!(error instanceof HttpRequestError && error.status !== undefined && error.status < 500 && error.status !== 408 && error.status !== 429)) {
      records[recordKey] = { fingerprint, state: 'unknown', updatedAt: Date.now() }
      await writeSyncRecords(records)
    }
    throw error
  }
}

export async function syncToNotion(todos: TodoItem[]): Promise<SyncResult[]> {
  const { notionApiKey, notionDatabaseId } = useSettingsStore.getState()
  if (!notionApiKey || !notionDatabaseId) {
    throw new Error('请先在设置中配置 Notion API Key 和 Database ID')
  }

  return runSequentially(async () => {
    const results: SyncResult[] = []
    for (const todo of todos) {
      try {
        results.push(await syncOne(todo))
      } catch (error) {
        results.push({
          id: todo.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          retryable: isRetryableRequestError(error),
        })
      }
    }
    return results
  })
}

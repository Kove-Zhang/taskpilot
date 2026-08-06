export type NotionSyncStatus =
  | 'idle'
  | 'syncing'
  | 'success'
  | 'failed'
  | 'partial_failed'
  | 'needs_verification'

export interface NotionSyncState {
  status: NotionSyncStatus
  total: number
  succeededCount: number
  failedCount: number
  failedTodoIds: string[]
  uncertainTodoIds: string[]
  lastError?: string
  lastAttemptAt?: string
}

export interface NotionSyncResultLike {
  id: string
  success: boolean
  needsVerification?: boolean
  error?: string
}

export function createNotionSyncInProgressState(
  total: number,
  _attemptedTodoIds: string[],
  now = new Date().toISOString(),
): NotionSyncState {
  return {
    status: 'syncing',
    total,
    succeededCount: 0,
    failedCount: 0,
    failedTodoIds: [],
    uncertainTodoIds: [],
    lastAttemptAt: now,
  }
}

export function summarizeNotionSyncResults(
  results: NotionSyncResultLike[],
  total = results.length,
  now = new Date().toISOString(),
): NotionSyncState {
  const succeeded = results.filter(result => result.success)
  const failed = results.filter(result => !result.success)
  const uncertain = failed.filter(result => result.needsVerification === true)
  const failedTodoIds = failed.map(result => result.id)
  const errors = [...new Set(failed.map(result => result.error).filter(Boolean))]

  let status: NotionSyncStatus = 'success'
  if (uncertain.length > 0) {
    status = 'needs_verification'
  } else if (failed.length > 0 && succeeded.length > 0) {
    status = 'partial_failed'
  } else if (failed.length > 0) {
    status = 'failed'
  }

  return {
    status,
    total,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    failedTodoIds,
    uncertainTodoIds: uncertain.map(result => result.id),
    lastError: errors.length > 0 ? errors.join('\n') : undefined,
    lastAttemptAt: now,
  }
}

export function createNotionSyncFailureState(
  total: number,
  failedTodoIds: string[],
  error: string,
  now = new Date().toISOString(),
): NotionSyncState {
  return {
    status: 'failed',
    total,
    succeededCount: 0,
    failedCount: failedTodoIds.length,
    failedTodoIds,
    uncertainTodoIds: [],
    lastError: error,
    lastAttemptAt: now,
  }
}

export function resolveNotionSyncTodos(
  state: NotionSyncState | undefined,
  resolvedTodoIds: string[],
  now = new Date().toISOString(),
): NotionSyncState | undefined {
  if (!state) return undefined

  const resolved = new Set(resolvedTodoIds)
  const failedTodoIds = state.failedTodoIds.filter(id => !resolved.has(id))
  const uncertainTodoIds = state.uncertainTodoIds.filter(id => !resolved.has(id))
  const failedCount = failedTodoIds.length
  const succeededCount = Math.max(0, state.total - failedCount - uncertainTodoIds.length)
  const status: NotionSyncStatus = uncertainTodoIds.length > 0
    ? 'needs_verification'
    : failedCount > 0
      ? (succeededCount > 0 ? 'partial_failed' : 'failed')
      : 'success'

  return {
    ...state,
    status,
    succeededCount,
    failedCount,
    failedTodoIds,
    uncertainTodoIds,
    lastError: failedCount > 0 ? state.lastError : undefined,
    lastAttemptAt: now,
  }
}

export function getNotionSyncButtonLabel(
  state: NotionSyncState | undefined,
  hasPendingVerification = false,
  legacySynced = false,
): string {
  if (state?.status === 'syncing') return '同步中...'
  if (!state && legacySynced) return '已同步'
  if (state?.status === 'success') return '已同步'
  if (hasPendingVerification || state?.status === 'needs_verification') return '待核验'
  if (state?.status === 'partial_failed') return `部分失败 · 重试 ${state.failedCount} 项`
  if (state?.status === 'failed') return '同步失败 · 重试'
  return '同步至 Notion'
}

export function getNotionSyncStatusLabel(state: NotionSyncState | undefined): string | undefined {
  if (!state || state.status === 'idle') return undefined
  if (state.status === 'syncing') return '同步中'
  if (state.status === 'success') return '已同步'
  if (state.status === 'needs_verification') return '待核验'
  if (state.status === 'partial_failed') return `部分失败（${state.failedCount} 项）`
  return '同步失败'
}

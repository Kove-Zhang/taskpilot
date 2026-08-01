export const NOTION_API_VERSION = '2022-06-28'

function requireNotionIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Notion ${label} 不能为空`)
  return encodeURIComponent(normalized)
}

export function notionDatabaseEndpoint(databaseId: string): string {
  return `https://api.notion.com/v1/databases/${requireNotionIdentifier(databaseId, 'Database ID')}`
}

export function notionPagesEndpoint(): string {
  return 'https://api.notion.com/v1/pages'
}

export function notionHeaders(apiKey: string, includeJsonContentType: boolean = false): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Notion-Version': NOTION_API_VERSION,
    ...(includeJsonContentType ? { 'Content-Type': 'application/json' } : {}),
  }
}

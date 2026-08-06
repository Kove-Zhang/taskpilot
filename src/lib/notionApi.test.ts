import { describe, expect, it } from 'vitest'
import { NOTION_API_VERSION, notionDatabaseEndpoint, notionHeaders, notionPagesEndpoint } from './notionApi'

describe('Notion API adapter', () => {
  it('centralizes versioned endpoints and request headers', () => {
    expect(notionDatabaseEndpoint('database id/with space')).toBe('https://api.notion.com/v1/databases/database%20id%2Fwith%20space')
    expect(notionPagesEndpoint()).toBe('https://api.notion.com/v1/pages')
    expect(notionHeaders('test-key', true)).toEqual({
      Authorization: 'Bearer test-key',
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
    })
  })

  it('rejects blank database identifiers before issuing a request', () => {
    expect(() => notionDatabaseEndpoint('   ')).toThrow('Database ID 不能为空')
  })
})

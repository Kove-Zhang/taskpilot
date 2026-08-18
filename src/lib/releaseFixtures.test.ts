import { describe, expect, it } from 'vitest'
import { assertReleaseFixtureIsRedacted, RELEASE_FIXTURES } from './releaseFixtures'

describe('release gate fixtures', () => {
  it('covers the required synthetic edge cases and stays redacted', () => {
    expect(RELEASE_FIXTURES.longThread.split('\n')).toHaveLength(24)
    expect(RELEASE_FIXTURES.chineseEmail.html).toContain('display:none')
    expect(RELEASE_FIXTURES.base64Image).toContain('[REDACTED_IMAGE_BYTES]')
    expect(RELEASE_FIXTURES.notionFields).toHaveLength(3)
    expect(RELEASE_FIXTURES.duplicateTodos[0].id).toBe(RELEASE_FIXTURES.duplicateTodos[1].id)
    assertReleaseFixtureIsRedacted(RELEASE_FIXTURES)
  })
})

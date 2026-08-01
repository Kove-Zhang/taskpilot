import { describe, expect, it } from 'vitest'
import { decodeIMAPFolder } from './imapFolder'

describe('decodeIMAPFolder', () => {
  it('maps common folders and preserves malformed modified UTF-7 input', () => {
    expect(decodeIMAPFolder('INBOX')).toBe('收件箱')
    expect(decodeIMAPFolder('&$-')).toBe('&$-')
  })
})

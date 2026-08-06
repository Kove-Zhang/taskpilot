import { describe, expect, it, vi } from 'vitest'
import { parseFile } from './parser'
import { FILE_PARSING_LIMITS, assertFileBatchWithinLimits, truncateExtractedText } from './fileLimits'

describe('file parsing limits', () => {
  it('rejects oversized files before attempting to read them', async () => {
    const text = vi.fn()
    const oversizedFile = {
      name: 'oversized.txt',
      size: FILE_PARSING_LIMITS.maxFileSizeBytes + 1,
      text,
    } as unknown as File

    await expect(parseFile(oversizedFile)).rejects.toThrow('超过 15 MB 解析上限')
    expect(text).not.toHaveBeenCalled()
  })

  it('rejects batches that exceed the file-count limit', () => {
    const files = Array.from({ length: FILE_PARSING_LIMITS.maxFilesPerBatch + 1 }, (_, index) => ({
      name: `file-${index}.txt`,
      size: 1,
    }))

    expect(() => assertFileBatchWithinLimits(files)).toThrow(`单次最多解析 ${FILE_PARSING_LIMITS.maxFilesPerBatch} 个文件`)
  })

  it('adds a visible truncation notice for oversized extracted text', () => {
    const parsed = truncateExtractedText('x'.repeat(FILE_PARSING_LIMITS.maxExtractedCharacters + 1), '文本文件')

    expect(parsed).toContain('已截断')
    expect(parsed.length).toBeGreaterThan(FILE_PARSING_LIMITS.maxExtractedCharacters)
  })
})

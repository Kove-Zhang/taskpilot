export const FILE_PARSING_LIMITS = {
  maxFileSizeBytes: 15 * 1024 * 1024,
  maxFilesPerBatch: 5,
  maxPdfPages: 30,
  maxExcelSheets: 10,
  maxExcelRowsPerSheet: 2_000,
  maxExtractedCharacters: 120_000,
} as const

type FileMetadata = Pick<File, 'name' | 'size'>

export function assertFileWithinLimits(file: FileMetadata): void {
  if (file.size > FILE_PARSING_LIMITS.maxFileSizeBytes) {
    throw new Error(`文件「${file.name}」超过 ${Math.floor(FILE_PARSING_LIMITS.maxFileSizeBytes / 1024 / 1024)} MB 解析上限。`)
  }
}

export function assertFileBatchWithinLimits(files: readonly FileMetadata[]): void {
  if (files.length === 0) {
    throw new Error('未选择文件。')
  }
  if (files.length > FILE_PARSING_LIMITS.maxFilesPerBatch) {
    throw new Error(`单次最多解析 ${FILE_PARSING_LIMITS.maxFilesPerBatch} 个文件。`)
  }
  files.forEach(assertFileWithinLimits)
}

export function truncateExtractedText(text: string, source: string): string {
  if (text.length <= FILE_PARSING_LIMITS.maxExtractedCharacters) return text
  return `${text.slice(0, FILE_PARSING_LIMITS.maxExtractedCharacters)}\n\n[${source}解析结果超过 ${FILE_PARSING_LIMITS.maxExtractedCharacters.toLocaleString()} 字符，已截断。]`
}

import * as mammoth from 'mammoth'
import * as xlsx from 'xlsx'
import {
  FILE_PARSING_LIMITS,
  assertFileWithinLimits,
  truncateExtractedText,
} from './fileLimits'

export { FILE_PARSING_LIMITS } from './fileLimits'

export async function parseFile(file: File): Promise<string> {
  assertFileWithinLimits(file)
  const extension = file.name.split('.').pop()?.toLowerCase()

  switch (extension) {
    case 'docx':
      return parseDocx(file)
    case 'xlsx':
    case 'xls':
    case 'csv':
      return parseExcel(file)
    case 'pdf':
      return parsePdf(file)
    case 'txt':
    case 'md':
      return truncateExtractedText(await file.text(), '文本文件')
    default:
      throw new Error(`暂不支持解析该格式: .${extension}`)
  }
}

async function parseDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return truncateExtractedText(result.value, 'DOCX')
}

async function parseExcel(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const workbook = xlsx.read(arrayBuffer, { type: 'array' })
  const sheetNames = workbook.SheetNames.slice(0, FILE_PARSING_LIMITS.maxExcelSheets)
  const sections = sheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    const rows = xlsx.utils.sheet_to_csv(sheet).split(/\r?\n/)
    const truncatedRows = rows.slice(0, FILE_PARSING_LIMITS.maxExcelRowsPerSheet)
    const rowNotice = rows.length > truncatedRows.length
      ? `\n[工作表行数超过 ${FILE_PARSING_LIMITS.maxExcelRowsPerSheet.toLocaleString()}，已截断。]`
      : ''
    return `--- Sheet: ${sheetName} ---\n${truncatedRows.join('\n')}${rowNotice}`
  })

  const sheetNotice = workbook.SheetNames.length > sheetNames.length
    ? `\n\n[工作簿工作表超过 ${FILE_PARSING_LIMITS.maxExcelSheets}，已截断。]`
    : ''
  return truncateExtractedText(`${sections.join('\n\n')}${sheetNotice}`, 'Excel')
}

async function parsePdf(file: File): Promise<string> {
  const [pdfjsLib, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default

  const arrayBuffer = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
  const pdf = await loadingTask.promise
  try {
    const pageCount = Math.min(pdf.numPages, FILE_PARSING_LIMITS.maxPdfPages)
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const strings = content.items.map((item) => ('str' in item ? item.str : ''))
      pages.push(strings.join(' '))
    }
    const pageNotice = pdf.numPages > pageCount
      ? `\n\n[PDF 共 ${pdf.numPages} 页，仅解析前 ${pageCount} 页。]`
      : ''
    return truncateExtractedText(`${pages.join('\n')}${pageNotice}`, 'PDF')
  } finally {
    await loadingTask.destroy()
  }
}

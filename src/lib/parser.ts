import * as mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist';

// Use a public CDN for the pdf.js worker to avoid Vite build configuration issues
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export async function parseFile(file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'docx':
      return await parseDocx(file);
    case 'xlsx':
    case 'xls':
    case 'csv':
      return await parseExcel(file);
    case 'pdf':
      return await parsePdf(file);
    case 'txt':
    case 'md':
      return await file.text();
    default:
      throw new Error(`暂不支持解析该格式: .${extension}`);
  }
}

async function parseDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function parseExcel(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = xlsx.read(arrayBuffer, { type: 'array' });
  let text = '';
  
  for (const sheetName of workbook.SheetNames) {
    text += `\n--- Sheet: ${sheetName} ---\n`;
    const sheet = workbook.Sheets[sheetName];
    const csv = xlsx.utils.sheet_to_csv(sheet);
    text += csv;
  }
  return text;
}

async function parsePdf(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => ('str' in item ? item.str : ''));
    text += strings.join(' ') + '\n';
  }
  
  return text;
}

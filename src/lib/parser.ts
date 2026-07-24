import * as mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Use local worker provided by Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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

export function decodeIMAPFolder(name: string): string {
    const common: Record<string, string> = {
        'INBOX': '收件箱',
        'Sent': '已发送',
        'Drafts': '草稿箱',
        'Trash': '已删除',
        'Junk': '垃圾邮件',
        'Spam': '垃圾邮件',
        'Archive': '归档',
        'Sent Messages': '已发送',
        'Deleted Messages': '已删除'
    };
    if (common[name]) {
        return common[name];
    }

    return name.replace(/&([^-]*)-/g, function(match, base64) {
        if (base64 === '') return '&';
        let b64 = base64.replace(/,/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        try {
            const bin = atob(b64);
            let res = '';
            for (let i = 0; i < bin.length; i += 2) {
                res += String.fromCharCode((bin.charCodeAt(i) << 8) | (bin.charCodeAt(i + 1) || 0));
            }
            return res;
        } catch (e) {
            return match;
        }
    });
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

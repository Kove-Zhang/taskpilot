export const EMAIL_HISTORY_TEXT_PREVIEW_LIMIT = 120_000
export const EMAIL_HISTORY_HTML_PREVIEW_LIMIT = 160_000

function limitHistoryContent(content: string | null | undefined, limit: number, contentLabel: string): string | undefined {
  if (!content) return undefined
  if (content.length <= limit) return content

  return `${content.slice(0, limit)}

[${contentLabel}超过 ${limit.toLocaleString()} 个字符；为控制本地历史文件大小，此记录仅保留开头内容。AI 分析仍按模型输入预算独立处理。]`
}

export function limitEmailHistoryText(content: string | null | undefined): string | undefined {
  return limitHistoryContent(content, EMAIL_HISTORY_TEXT_PREVIEW_LIMIT, '邮件正文')
}

export function limitEmailHistoryHtml(content: string | null | undefined): string | undefined {
  return limitHistoryContent(content, EMAIL_HISTORY_HTML_PREVIEW_LIMIT, '邮件 HTML 正文')
}

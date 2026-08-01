export function decodeIMAPFolder(name: string): string {
  const common: Record<string, string> = {
    INBOX: '收件箱',
    Sent: '已发送',
    Drafts: '草稿箱',
    Trash: '已删除',
    Junk: '垃圾邮件',
    Spam: '垃圾邮件',
    Archive: '归档',
    'Sent Messages': '已发送',
    'Deleted Messages': '已删除',
  }
  if (common[name]) return common[name]

  return name.replace(/&([^-]*)-/g, (match, base64) => {
    if (base64 === '') return '&'
    let b64 = base64.replace(/,/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    try {
      const bin = atob(b64)
      let result = ''
      for (let index = 0; index < bin.length; index += 2) {
        result += String.fromCharCode((bin.charCodeAt(index) << 8) | (bin.charCodeAt(index + 1) || 0))
      }
      return result
    } catch {
      return match
    }
  })
}

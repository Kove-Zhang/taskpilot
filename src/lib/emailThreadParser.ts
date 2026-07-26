/**
 * emailThreadParser.ts
 * 智能邮件会话转发切片解析引擎
 * 专门用于解决长期循环转发、多重引用导致的巨型长文（如数十封往期回帖）
 * 解决 AI Token 消耗过大、可读性极差及划选失焦的行业痛点
 */

export interface EmailThreadSlice {
  index: number;         // 序号: 0 表示第一次转发/引用的历史，1 表示更古老的历史...
  sender?: string;       // 历史发件人
  sendTime?: string;     // 历史发送时间
  recipients?: string;   // 历史收件人/抄送
  subject?: string;      // 历史主题
  content: string;       // 历史正文片段 (可含 HTML 或纯文本)
  wordCount: number;     // 该片段字数统计
}

export interface ParsedEmailThread {
  latestMessage: string;                 // 本次最新发信/回信核心正文
  historicalThreads: EmailThreadSlice[]; // 历史回帖切片矩阵
  totalWords: number;                    // 整体总字数
  reducedWords: number;                  // 被收纳折叠的历史冗余字数
  hasHistory: boolean;                   // 是否检测到转发回帖
}

/**
 * 辅助函数：去除非法空白与 HTML 标签，清洗提取的元数据字段
 */
function cleanMetadataField(val: string): string {
  if (!val) return '';
  // 移除 html 标签
  let cleaned = val.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/ig, ' ');
  // 移除转义或引号及左右多余空白
  cleaned = cleaned.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * 核心解析引擎：切割邮件长文并分离出最新回信与往期回帖链
 * 兼容铁塔/网易/腾讯/Outlook/Exchange 等主流企业邮箱格式
 */
export function parseEmailThread(content: string, _isHtml: boolean = false): ParsedEmailThread {
  if (!content || !content.trim()) {
    return {
      latestMessage: '',
      historicalThreads: [],
      totalWords: 0,
      reducedWords: 0,
      hasHistory: false
    };
  }

  const totalWords = content.length;

  // 1. 寻找所有的会话分隔与引用头触发锚点 (发件人:/From:/寄件者:)
  // 匹配含冒号的发件人关键字
  const senderAnchorRegex = /(?:发件人|From|寄件者)\s*[:：]/gi;
  const cutPositions: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = senderAnchorRegex.exec(content)) !== null) {
    const pos = match.index;
    
    // 检查此点向后 600 字符内，是否存在同源元数据指标 (发送时间/收件人/主题)
    const afterSnippet = content.substring(pos, pos + 600);
    const hasMetadataFollowup = /(?:发送时间|发送日期|时间|日期|Sent|Date|收件人|To|主\s*题|Subject|抄\s*送|CC)\s*[:：]/i.test(afterSnippet);

    // 检查此点向前 300 字符内，是否存在明显的分隔线或 Original Message 等头部标记
    const beforeStart = Math.max(0, pos - 300);
    const beforeSnippet = content.substring(beforeStart, pos);
    
    // 识别常见分隔符：长下划线/短横线/等号/减号 >= 10个，或 Original Message / Forwarded message / <hr>
    const dividerRegex = /((?:[-=_—]{10,})|(?:----+Original\s+Message----+)|(?:----+Forwarded\s+message----+)|(?:<hr\s*[^>]*>)|(?:<div\s+style="[^"]*border-top[^"]*">))/gi;
    let dividerMatch: RegExpExecArray | null = null;
    let tempMatch: RegExpExecArray | null;
    while ((tempMatch = dividerRegex.exec(beforeSnippet)) !== null) {
      dividerMatch = tempMatch;
    }

    if (dividerMatch) {
      // 如果存在前置分隔线，切割点应该定位在离发件人最近的那条分隔线最前端！
      const actualCutPos = beforeStart + dividerMatch.index;
      cutPositions.push(actualCutPos);
    } else if (hasMetadataFollowup && pos >= 0) {
      // 如果没有明显的长横线，但紧跟着发送时间/收件人/主题等关键信息，说明是无分界线的回帖块
      // 寻找该行起始或上一个换行符/标尺
      let lineStart = content.lastIndexOf('\n', pos);
      if (lineStart === -1) lineStart = content.lastIndexOf('<br', pos);
      if (lineStart === -1 || pos - lineStart > 50) lineStart = pos;
      cutPositions.push(lineStart);
    }
  }

  // 排序并去重切割位置 (允许误差 15 字符内的重复锚点归一化)
  cutPositions.sort((a, b) => a - b);
  const uniqueCuts: number[] = [];
  for (const pos of cutPositions) {
    if (uniqueCuts.length === 0 || pos - uniqueCuts[uniqueCuts.length - 1] > 15) {
      uniqueCuts.push(pos);
    }
  }

  // 若未发现合理的切割点，说明整篇就是一封纯粹的邮件，没有转发引用
  if (uniqueCuts.length === 0) {
    return {
      latestMessage: content,
      historicalThreads: [],
      totalWords,
      reducedWords: 0,
      hasHistory: false
    };
  }

  // 2. 实施切片分离
  const firstCut = uniqueCuts[0];
  let latestMessage = content.substring(0, firstCut).trim();
  if (!latestMessage && firstCut === 0) {
    latestMessage = '（此邮件无新写回信，正文直接转发了历史会话记录）';
  }

  const historicalThreads: EmailThreadSlice[] = [];
  for (let i = 0; i < uniqueCuts.length; i++) {
    const startPos = uniqueCuts[i];
    const endPos = (i + 1 < uniqueCuts.length) ? uniqueCuts[i + 1] : content.length;
    const sliceContent = content.substring(startPos, endPos).trim();

    if (!sliceContent) continue;

    // 提取头 800 字符进行表头分析
    const headerInspect = sliceContent.substring(0, 800);
    
    // 提取发件人
    const senderMatch = /(?:发件人|From|寄件者)\s*[:：]\s*([^\r\n<]+|<[^>]+>[^\r\n<]*)/i.exec(headerInspect);
    const sender = senderMatch ? cleanMetadataField(senderMatch[1]) : '往期发件人';

    // 提取发送时间
    const timeMatch = /(?:发送时间|发送日期|时间|日期|Sent|Date)\s*[:：]\s*([^\r\n<]+|<[^>]+>[^\r\n<]*)/i.exec(headerInspect);
    const sendTime = timeMatch ? cleanMetadataField(timeMatch[1]) : '';

    // 提取收件人/抄送
    const recMatch = /(?:收件人|To|收件者)\s*[:：]\s*([^\r\n<]+|<[^>]+>[^\r\n<]*)/i.exec(headerInspect);
    const recipients = recMatch ? cleanMetadataField(recMatch[1]) : '';

    // 提取主题
    const subMatch = /(?:主\s*题|Subject|主\s*旨)\s*[:：]\s*([^\r\n<]+|<[^>]+>[^\r\n<]*)/i.exec(headerInspect);
    const subject = subMatch ? cleanMetadataField(subMatch[1]) : '';

    historicalThreads.push({
      index: i,
      sender,
      sendTime,
      recipients,
      subject,
      content: sliceContent,
      wordCount: sliceContent.length
    });
  }

  const reducedWords = historicalThreads.reduce((sum, item) => sum + item.wordCount, 0);

  return {
    latestMessage,
    historicalThreads,
    totalWords,
    reducedWords,
    hasHistory: historicalThreads.length > 0
  };
}

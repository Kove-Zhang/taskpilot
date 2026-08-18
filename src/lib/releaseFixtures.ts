/** Fully synthetic, redacted fixtures used by the release gate. */
export const RELEASE_FIXTURES = {
  chineseEmail: {
    subject: '项目周会跟进（脱敏）',
    html: '<p>请在周五前确认接口排期。</p><span style="display:none">hidden-marker-only</span>',
    text: '请在周五前确认接口排期。',
  },
  longThread: Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 轮讨论：确认公开的交付项。`).join('\n'),
  base64Image: 'data:image/png;base64,[REDACTED_IMAGE_BYTES]',
  notionFields: [
    { id: 'title', name: '任务标题', type: 'title' },
    { id: 'status', name: '状态', type: 'status', options: ['待办', '完成'] },
    { id: 'dynamic-1', name: '动态字段', type: 'select', options: ['A', 'B'] },
  ],
  emptyTodo: { id: 'todo-empty', title: '', priority: 'Low', planned_date: null },
  malformedDate: { id: 'todo-date', title: '校验日期', priority: 'Medium', planned_date: '2026-99-99' },
  duplicateTodos: [
    { id: 'todo-duplicate', title: '同一公开任务', priority: 'High', planned_date: null },
    { id: 'todo-duplicate', title: '同一公开任务', priority: 'High', planned_date: null },
  ],
  retryAfter: { seconds: '3', httpDate: 'Wed, 21 Oct 2015 07:28:00 GMT' },
} as const

export function assertReleaseFixtureIsRedacted(value: unknown): void {
  const serialized = JSON.stringify(value)
  if (/sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9]|api[_-]?key\s*[:=]/i.test(serialized)) {
    throw new Error('发布 fixture 不得包含疑似密钥或 Authorization')
  }
  if (serialized.includes('完整邮件正文') || serialized.includes('真实图片')) {
    throw new Error('发布 fixture 不得包含业务正文或真实图片')
  }
}

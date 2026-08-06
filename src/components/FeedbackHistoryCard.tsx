import type { FeedbackStatus, FeedbackType } from '../lib/feedbackAvailability'

interface FeedbackHistoryCardProps {
  feedbackStatus?: FeedbackStatus
  feedbackType?: FeedbackType
  explicitFeedback?: string
  /** Supports records created before feedbackType was introduced. */
  isRejected?: boolean
}

function resolveFeedbackType(
  feedbackType: FeedbackType | undefined,
  isRejected: boolean | undefined,
): FeedbackType | undefined {
  if (feedbackType) return feedbackType
  return isRejected ? 'over_extraction' : undefined
}


export function FeedbackStatusBadge({
  feedbackStatus,
  feedbackType,
  explicitFeedback,
  isRejected,
}: FeedbackHistoryCardProps) {
  const resolvedType = resolveFeedbackType(feedbackType, isRejected)
  const hasFeedbackRecord = Boolean(resolvedType || feedbackStatus || explicitFeedback?.trim())

  if (!hasFeedbackRecord) return null

  if (feedbackStatus === 'processing') {
    return (
      <span
        aria-label="反馈学习中"
        className="inline-flex h-6 items-center gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/15 px-2.5 py-0.5 text-xs font-medium text-yellow-300 shadow-sm shadow-yellow-500/10"
      >
        ⏳ 反馈学习中
      </span>
    )
  }

  if (resolvedType === 'missed_extraction') {
    return (
      <span
        aria-label="已反馈：漏提取"
        className="inline-flex h-6 items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300 shadow-sm shadow-amber-500/10"
      >
        ⚠️ 已反馈：漏提取
      </span>
    )
  }

  return (
    <span
      aria-label={resolvedType === 'over_extraction' ? '已反馈：误提取' : '已提交反馈'}
      className="inline-flex h-6 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-300 shadow-sm shadow-red-500/10"
    >
      👎 {resolvedType === 'over_extraction' ? '已反馈：误提取' : '已提交反馈'}
    </span>
  )
}

export function FeedbackHistoryCard({
  feedbackStatus,
  feedbackType,
  explicitFeedback,
  isRejected,
}: FeedbackHistoryCardProps) {
  const resolvedType = resolveFeedbackType(feedbackType, isRejected)
  const hasFeedbackRecord = Boolean(resolvedType || feedbackStatus || explicitFeedback?.trim())

  if (!hasFeedbackRecord) return null

  const isMissedExtraction = resolvedType === 'missed_extraction'
  const typeLabel = isMissedExtraction ? '漏提取反馈' : '误提取反馈'
  const statusLabel = feedbackStatus === 'processing' ? '学习处理中' : '已提交'

  return (
    <section
      aria-label="已提交的 AI 反馈"
      className={`mt-3 rounded-md border p-3 ${
        isMissedExtraction
          ? 'border-amber-500/30 bg-amber-950/20'
          : 'border-red-500/25 bg-red-950/25'
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          aria-label={typeLabel}
          className={`rounded border px-2 py-0.5 text-xs font-medium ${
            isMissedExtraction
              ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
              : 'border-red-500/30 bg-red-500/15 text-red-300'
          }`}
        >
          {isMissedExtraction ? '⚠️' : '👎'} {typeLabel}
        </span>
        <span className="text-xs text-slate-400">{statusLabel}</span>
      </div>
      <div className="mb-1 text-xs text-slate-400">提交给 AI 的说明：</div>
      <blockquote className="whitespace-pre-wrap break-words border-l-2 border-white/15 pl-3 text-sm italic text-slate-200">
        {explicitFeedback?.trim() || '未填写文字说明（仅提交了反馈类型）。'}
      </blockquote>
    </section>
  )
}

export type FeedbackStatus = 'processing' | 'completed' | undefined
export type FeedbackType = 'over_extraction' | 'missed_extraction'

/**
 * Explicit feedback is a user decision about extraction quality, not a Notion
 * delivery state. It therefore remains available after a successful sync.
 */
export function canProvideExplicitFeedback(status: FeedbackStatus): boolean {
  return status !== 'processing' && status !== 'completed'
}

export function getFeedbackType(todoCount: number): FeedbackType {
  return todoCount === 0 ? 'missed_extraction' : 'over_extraction'
}

export function isMissedExtractionFeedback(type: FeedbackType | undefined): boolean {
  return type === 'missed_extraction'
}

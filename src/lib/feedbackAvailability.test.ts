import { describe, expect, it } from 'vitest'
import {
  canProvideExplicitFeedback,
  getFeedbackType,
  isMissedExtractionFeedback,
} from './feedbackAvailability'

describe('canProvideExplicitFeedback', () => {
  it('keeps feedback available for a new or synced result', () => {
    expect(canProvideExplicitFeedback(undefined)).toBe(true)
  })

  it('hides feedback while the background review is running', () => {
    expect(canProvideExplicitFeedback('processing')).toBe(false)
  })

  it('hides feedback after the review has completed', () => {
    expect(canProvideExplicitFeedback('completed')).toBe(false)
  })
})

describe('getFeedbackType', () => {
  it('classifies an empty extraction as missed extraction feedback', () => {
    const type = getFeedbackType(0)
    expect(type).toBe('missed_extraction')
    expect(isMissedExtractionFeedback(type)).toBe(true)
  })

  it('classifies a non-empty extraction as over extraction feedback', () => {
    const type = getFeedbackType(2)
    expect(type).toBe('over_extraction')
    expect(isMissedExtractionFeedback(type)).toBe(false)
  })
})

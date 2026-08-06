import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FeedbackHistoryCard, FeedbackStatusBadge } from './FeedbackHistoryCard'

describe('FeedbackHistoryCard', () => {
  it('renders persisted missed-extraction feedback text and status', () => {
    render(
      <FeedbackHistoryCard
        feedbackType="missed_extraction"
        feedbackStatus="completed"
        explicitFeedback="请识别“周五前确认报价”这类行动项。"
      />,
    )

    expect(screen.getByLabelText('已提交的 AI 反馈')).toBeInTheDocument()
    expect(screen.getByLabelText('漏提取反馈')).toBeInTheDocument()
    expect(screen.getByText('已提交')).toBeInTheDocument()
    expect(screen.getByText('请识别“周五前确认报价”这类行动项。')).toBeInTheDocument()
  })

  it('renders legacy rejected records as over-extraction feedback', () => {
    render(<FeedbackHistoryCard isRejected explicitFeedback="不要提取问候语。" />)

    expect(screen.getByLabelText('误提取反馈')).toBeInTheDocument()
    expect(screen.getByText('不要提取问候语。')).toBeInTheDocument()
  })

  it('does not render when a history record has no feedback data', () => {
    const { container } = render(<FeedbackHistoryCard />)
    expect(container).toBeEmptyDOMElement()
  })
})


describe('FeedbackStatusBadge', () => {
  it('renders a compact missed-extraction marker for history lists', () => {
    render(<FeedbackStatusBadge feedbackType="missed_extraction" feedbackStatus="completed" />)
    expect(screen.getByLabelText('已反馈：漏提取')).toBeInTheDocument()
  })

  it('prioritizes the processing marker while feedback is still running', () => {
    render(<FeedbackStatusBadge feedbackType="over_extraction" feedbackStatus="processing" />)
    expect(screen.getByLabelText('反馈学习中')).toBeInTheDocument()
  })

  it('renders a legacy rejected record as an over-extraction marker', () => {
    render(<FeedbackStatusBadge isRejected />)
    expect(screen.getByLabelText('已反馈：误提取')).toBeInTheDocument()
  })
})

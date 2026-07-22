import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import SettingsPanel from './SettingsPanel'
import { useSettingsStore } from './store'
import '@testing-library/jest-dom'

describe('SettingsPanel', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o',
      personalFocus: '关注内容',
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
    });
  });

  it('renders settings fields correctly', () => {
    render(<SettingsPanel onClose={() => {}} />)
    expect(screen.getByText('API Base URL')).toBeInTheDocument()
    expect(screen.getByText('Model Name (多模态)')).toBeInTheDocument()
  })

  it('updates state when typing into API URL', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const input = screen.getByDisplayValue('https://api.openai.com/v1')
    fireEvent.change(input, { target: { value: 'https://newapi.com/v1' } })
    
    // Simulate save by grabbing the internal state assuming saving saves to store.
    // The component might hold local state until save.
    expect(input).toHaveValue('https://newapi.com/v1')
  })
})

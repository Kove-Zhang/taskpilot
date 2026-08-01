import { invoke } from '@tauri-apps/api/core'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
    expect(screen.getByText('Model Name (如 gpt-4o)')).toBeInTheDocument()
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

  it('unregisters the persisted global shortcut while recording and restores it after blur', async () => {
    vi.mocked(invoke).mockClear()
    render(<SettingsPanel onClose={() => {}} />)

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    vi.mocked(invoke).mockClear()

    const recorder = screen.getByTitle('点击此处后直接按下您想使用的组合键（如 Ctrl+Shift+S）')
    fireEvent.focus(recorder)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_recording_mode', { isRecording: true })
      expect(invoke).toHaveBeenCalledWith('unregister_shortcut')
    })

    fireEvent.blur(recorder)
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_recording_mode', { isRecording: false })
      expect(invoke).toHaveBeenCalledWith('update_shortcut', { shortcut: 'Alt+Space' })
    })
  })
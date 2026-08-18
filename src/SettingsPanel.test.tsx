import { invoke } from '@tauri-apps/api/core'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import SettingsPanel from './SettingsPanel'
import { useSettingsStore } from './store'
import { llmEventStore } from './lib/llm/events'
import '@testing-library/jest-dom'

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    llmEventStore.clear()
    useSettingsStore.setState({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o',
      personalFocus: '关注内容',
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
      enableFailover: true,
      failoverRetryCount: 1,
      failoverOnAuthError: false,
      experimentalLLMRoutingEnabled: false,
      experimentalProviderHealthEnabled: false,
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

  it('defaults experimental policies to off and exposes redacted baseline exports', () => {
    render(<SettingsPanel onClose={() => {}} />)

    expect(screen.getByLabelText('启用实验性路由排序/降级策略')).not.toBeChecked()
    expect(screen.getByLabelText('启用实验性 Provider Health 候选策略')).not.toBeChecked()
    expect(screen.getByText('Provider Health 实验策略当前已关闭：健康卡片仅用于查看脱敏历史统计，不会据此冷却、半开恢复或跳过候选。可勾选下方开关并保存以恢复该策略。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 24h 基线（Markdown）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 24h 基线（JSON）' })).toBeInTheDocument()
  })

  it('keeps advanced provider fields collapsed until requested and blocks unsupported protocols', () => {
    render(<SettingsPanel onClose={() => {}} />)

    expect(screen.queryByLabelText('连接超时')).not.toBeInTheDocument()
    const advanced = screen.getByRole('button', { name: /高级配置：能力、超时、重试、成本与请求覆写/ })
    expect(advanced).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(advanced)

    expect(advanced).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('连接超时')).toBeInTheDocument()
    expect(screen.getByLabelText('首字节超时')).toBeInTheDocument()
    expect(screen.getByLabelText('总超时')).toBeInTheDocument()
    expect(screen.getByLabelText('最大重试次数')).toBeInTheDocument()
    expect(screen.getByLabelText('图片单次成本')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'OpenAI Responses（当前版本未支持）' })).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Anthropic Messages（当前版本未支持）' })).toBeDisabled()
  })

  it('exports the current redacted event snapshot through the desktop download path', () => {
    const createObjectURL = vi.fn(() => 'blob:baseline')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<SettingsPanel onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '导出 24h 基线（Markdown）' }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(screen.getByText('已导出最近 24 小时的脱敏发布基线（MARKDOWN，0 条事件）。')).toBeInTheDocument()
  })

  it('keeps full prompt logging disabled by default and persists it after saving', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const promptLogging = screen.getByRole('checkbox', { name: /记录提交给大模型的完整提示词/ }) as HTMLInputElement

    expect(promptLogging).not.toBeChecked()
    expect(promptLogging).toBeDisabled()

    fireEvent.click(screen.getByLabelText('开启本地详细日志记录'))
    expect(promptLogging).not.toBeDisabled()
    fireEvent.click(promptLogging)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(useSettingsStore.getState().enablePromptLogging).toBe(true)
  })

  it('persists structured email scan filters after saving', () => {
    const current = useSettingsStore.getState().emailConfig
    useSettingsStore.setState({
      emailConfig: {
        ...current,
        enabled: true,
        autoScanFilter: { readState: 'unread', systemFlags: [], keywords: [], excludeKeywords: [] },
        manualScanFilter: { readState: 'all', systemFlags: [], keywords: [], excludeKeywords: [] },
      },
    })
    render(<SettingsPanel onClose={() => {}} />)

    fireEvent.click(screen.getAllByLabelText('旗标')[0])
    fireEvent.change(screen.getAllByPlaceholderText('包含标签（逗号分隔，可选）')[0], { target: { value: 'Project-A, VIP' } })
    fireEvent.change(screen.getAllByPlaceholderText('排除标签（逗号分隔，可选）')[0], { target: { value: 'newsletter' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(useSettingsStore.getState().emailConfig.autoScanFilter).toEqual({
      readState: 'unread',
      systemFlags: ['flagged'],
      keywords: ['Project-A', 'VIP'],
      excludeKeywords: ['newsletter'],
    })
  })

  it('persists the optional 401 fallback setting only after saving', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const option = screen.getByLabelText('认证失败（401）时也尝试备用服务商') as HTMLInputElement

    expect(option).not.toBeChecked()
    fireEvent.click(option)
    expect(option).toBeChecked()
    expect(useSettingsStore.getState().failoverOnAuthError).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(useSettingsStore.getState().failoverOnAuthError).toBe(true)
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

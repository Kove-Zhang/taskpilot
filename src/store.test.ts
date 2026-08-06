import { describe, it, expect, beforeEach } from 'vitest'
import { useScannerStore, useSettingsStore } from './store'

describe('SettingsStore', () => {
  beforeEach(() => {
    // Reset the store
    useSettingsStore.setState({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o',
      personalFocus: '关注内容的核心逻辑和可操作的待办事项。',
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
    });
  });

  it('should have correct default settings', () => {
    const state = useSettingsStore.getState();
    expect(state.modelName).toBe('gpt-4o');
    expect(state.enableLogging).toBe(false);
  });

  it('should allow setting new values', () => {
    useSettingsStore.getState().setApiSettings('test-url', 'test-key', 'qwen3.7-plus');
    useSettingsStore.getState().setEnableLogging(true);

    const state = useSettingsStore.getState();
    expect(state.modelName).toBe('qwen3.7-plus');
    expect(state.enableLogging).toBe(true);
  });

  it('should configure email scan read scope and batch size', () => {
    useSettingsStore.getState().setEmailConfig({ autoUnreadOnly: false, manualUnreadOnly: true, maxEmailsPerFolder: 200 })

    expect(useSettingsStore.getState().emailConfig).toMatchObject({
      autoUnreadOnly: false,
      manualUnreadOnly: true,
      maxEmailsPerFolder: 200,
    })
  })
});


describe('ScannerStore', () => {
  beforeEach(() => {
    useScannerStore.setState({
      running: true,
      paused: true,
      status: 'paused',
      stopRequested: false,
      progressMsg: '',
      scanLogs: [],
      historyVersion: 0,
    })
  })

  it('enters stopping state and clears pause when stop is requested', () => {
    useScannerStore.getState().requestStop()

    expect(useScannerStore.getState()).toMatchObject({
      paused: false,
      stopRequested: true,
      status: 'stopping',
      progressMsg: '正在停止，等待当前邮件处理完成...',
    })
  })

  it('does not allow pause to be re-enabled after stopping', () => {
    useScannerStore.getState().requestStop()
    useScannerStore.getState().setPaused(true)

    expect(useScannerStore.getState()).toMatchObject({
      paused: false,
      stopRequested: true,
      status: 'stopping',
    })
  })
})

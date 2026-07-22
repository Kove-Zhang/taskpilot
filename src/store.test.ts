import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from './store'

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
});

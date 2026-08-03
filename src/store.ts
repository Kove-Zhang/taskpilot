import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import { LazyStore } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'

const tauriStore = new LazyStore('settings.json');

const secureStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const oldData = localStorage.getItem(name);
      if (oldData) {
        await secureStorage.setItem!(name, oldData);
        localStorage.removeItem(name);
        return oldData; 
      }
      
      const valueStr = await tauriStore.get<string>(name);
      if (!valueStr) return null;

      try {
        const parsed = JSON.parse(valueStr);
        if (parsed.state?.apiKey) {
          parsed.state.apiKey = await invoke('decrypt_secret', { cipherText: parsed.state.apiKey });
        }
        if (parsed.state?.notionApiKey) {
          parsed.state.notionApiKey = await invoke('decrypt_secret', { cipherText: parsed.state.notionApiKey });
        }
        if (parsed.state?.emailConfig?.pass) {
          parsed.state.emailConfig.pass = await invoke('decrypt_secret', { cipherText: parsed.state.emailConfig.pass });
        }
        if (parsed.state?.llmProviders && Array.isArray(parsed.state.llmProviders)) {
          for (const p of parsed.state.llmProviders) {
            if (p.apiKey) {
              p.apiKey = await invoke('decrypt_secret', { cipherText: p.apiKey });
            }
          }
        }
        return JSON.stringify(parsed);
      } catch (e) {
        console.warn("Parse or decrypt error:", e);
        return valueStr;
      }
    } catch (err) {
      console.error("Store getItem error:", err);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const parsed = JSON.parse(value);
      if (parsed.state?.apiKey) {
        parsed.state.apiKey = await invoke('encrypt_secret', { value: parsed.state.apiKey });
      }
      if (parsed.state?.notionApiKey) {
        parsed.state.notionApiKey = await invoke('encrypt_secret', { value: parsed.state.notionApiKey });
      }
      if (parsed.state?.emailConfig?.pass) {
        parsed.state.emailConfig.pass = await invoke('encrypt_secret', { value: parsed.state.emailConfig.pass });
      }
      if (parsed.state?.llmProviders && Array.isArray(parsed.state.llmProviders)) {
        for (const p of parsed.state.llmProviders) {
          if (p.apiKey) {
            p.apiKey = await invoke('encrypt_secret', { value: p.apiKey });
          }
        }
      }
      await tauriStore.set(name, JSON.stringify(parsed));
      await tauriStore.save();
    } catch (e) {
      console.error("Failed to encrypt and save state", e);
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await tauriStore.delete(name);
      await tauriStore.save();
    } catch (err) {
      console.error("Store removeItem error:", err);
    }
  }
};

export interface LLMProvider {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  enabled: boolean;
  priority: number;
}

export type FieldType = 'title' | 'rich_text' | 'select' | 'multi_select' | 'date' | 'checkbox' | 'number' | string;

export interface NotionProperty {
  id: string;
  name: string;
  type: FieldType;
  options?: string[]; // For select/multi_select
}

export interface FieldMapping {
  notionPropId: string;
  enabled: boolean;
  aiHint: string;
  order: number;
}

export interface EmailConfig {
  host: string;
  port: number;
  ssl: boolean;
  user: string;
  pass: string;
  targetFolder: string;
  scheduleDays: number[]; // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  scheduleTime: string; // e.g. "09:00" or interval like "every_1h", "every_3h"
  markAsRead: boolean;
  retryCount: number;
  enabled: boolean;
  autoSyncToNotion: boolean;
  autoUnreadOnly: boolean;
  manualUnreadOnly: boolean;
  autoReadDays: number;
  manualReadDays: number;
  maxEmailsPerFolder: number;
}

interface SettingsState {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  personalFocus: string; // legacy fallback
  promptMode: 'static' | 'auto';
  staticPersonalFocus: string;
  staticFocusUpdatedAt: number;
  autoOptimizedFocus: string;
  autoOptimizedUpdatedAt: number;
  notionApiKey: string;
  notionDatabaseId: string;
  enableLogging: boolean;
  globalShortcut: string;
  notionProperties: NotionProperty[];
  fieldMappings: Record<string, FieldMapping>;
  tokenLimit: number;
  enableReasoning: boolean;
  emailConfig: EmailConfig;
  llmProviders?: LLMProvider[];
  enableFailover: boolean;
  failoverRetryCount: number;
  failoverOnAuthError: boolean;
  isWindowMode: boolean;
  setLLMProviders: (providers: LLMProvider[]) => void;
  setFailoverConfig: (enable: boolean, retryCount: number, failoverOnAuthError: boolean) => void;
  setApiSettings: (baseUrl: string, key: string, model: string) => void;
  setPersonalFocus: (focus: string) => void; // Legacy
  setPromptMode: (mode: 'static' | 'auto') => void;
  setStaticFocus: (focus: string) => void;
  setAutoOptimizedFocus: (focus: string) => void;
  setNotionSettings: (key: string, dbId: string) => void;
  setEnableLogging: (enable: boolean) => void;
  setGlobalShortcut: (shortcut: string) => void;
  setNotionProperties: (props: NotionProperty[]) => void;
  setFieldMapping: (notionPropId: string, mapping: FieldMapping) => void;
  setTokenLimit: (limit: number) => void;
  setEnableReasoning: (enable: boolean) => void;
  setEmailConfig: (config: Partial<EmailConfig>) => void;
  setWindowMode: (enable: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o',
      personalFocus: '关注内容的核心逻辑和可操作的待办事项。',
      promptMode: 'static',
      staticPersonalFocus: '',
      staticFocusUpdatedAt: 0,
      autoOptimizedFocus: '',
      autoOptimizedUpdatedAt: 0,
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
      globalShortcut: 'Alt+Space',
      notionProperties: [],
      fieldMappings: {},
      tokenLimit: 8000,
      enableReasoning: false,
      emailConfig: {
        host: '',
        port: 993,
        ssl: true,
        user: '',
        pass: '',
        targetFolder: 'INBOX',
        scheduleDays: [1, 2, 3, 4, 5],
        scheduleTime: 'every_1h',
        markAsRead: false,
        retryCount: 1,
        enabled: false,
        autoSyncToNotion: false,
        autoUnreadOnly: true,
        manualUnreadOnly: false,
        autoReadDays: 3,
        manualReadDays: 7,
        maxEmailsPerFolder: 50
      },
      enableFailover: true,
      failoverRetryCount: 1,
      failoverOnAuthError: false,
      isWindowMode: false,
      setApiSettings: (apiBaseUrl, apiKey, modelName) => set((state) => {
        const providers = state.llmProviders && state.llmProviders.length > 0
          ? state.llmProviders.map((p, idx) => idx === 0 ? { ...p, apiBaseUrl, apiKey, modelName } : p)
          : [{ id: 'default-provider', name: '默认模型服务商', apiBaseUrl, apiKey, modelName, enabled: true, priority: 1 }];
        return { apiBaseUrl, apiKey, modelName, llmProviders: providers };
      }),
      setLLMProviders: (llmProviders) => set(() => {
        const sorted = [...llmProviders].sort((a, b) => a.priority - b.priority);
        const top = sorted.find(p => p.enabled) || sorted[0];
        if (top) {
          return { llmProviders, apiBaseUrl: top.apiBaseUrl, apiKey: top.apiKey, modelName: top.modelName };
        }
        return { llmProviders };
      }),
      setFailoverConfig: (enableFailover, failoverRetryCount, failoverOnAuthError) => set({ enableFailover, failoverRetryCount, failoverOnAuthError }),
      setPersonalFocus: (personalFocus) => set({ personalFocus }),
      setPromptMode: (promptMode) => set({ promptMode }),
      setStaticFocus: (staticPersonalFocus) => set({ 
        staticPersonalFocus, 
        staticFocusUpdatedAt: Date.now() 
      }),
      setAutoOptimizedFocus: (autoOptimizedFocus) => set({ 
        autoOptimizedFocus, 
        autoOptimizedUpdatedAt: Date.now() 
      }),
      setNotionSettings: (notionApiKey, notionDatabaseId) => set({ notionApiKey, notionDatabaseId }),
      setEnableLogging: (enableLogging) => set({ enableLogging }),
      setGlobalShortcut: (globalShortcut) => set({ globalShortcut }),
      setNotionProperties: (props) => set({ notionProperties: props }),
      setFieldMapping: (id, mapping) => set((state) => ({
        fieldMappings: {
          ...state.fieldMappings,
          [id]: mapping
        }
      })),
      setTokenLimit: (tokenLimit) => set({ tokenLimit }),
      setEnableReasoning: (enableReasoning) => set({ enableReasoning }),
      setEmailConfig: (config: Partial<EmailConfig>) => set((state) => ({ 
        emailConfig: { ...state.emailConfig, ...config } 
      })),
      setWindowMode: (isWindowMode) => set({ isWindowMode }),
    }),
    {
      name: 'task-pilot-settings',
      storage: createJSONStorage(() => secureStorage),
    }
  )
)

export type ScannerStatus = 'idle' | 'fetching' | 'processing' | 'paused' | 'stopping' | 'completed' | 'stopped' | 'failed';

export interface ScannerState {
  running: boolean;
  paused: boolean;
  status: ScannerStatus;
  stopRequested: boolean;
  progressMsg: string;
  scanLogs: string[];
  historyVersion: number;
  setRunning: (running: boolean) => void;
  setPaused: (paused: boolean) => void;
  setStatus: (status: ScannerStatus) => void;
  requestStop: () => void;
  clearStopRequest: () => void;
  setProgressMsg: (progressMsg: string) => void;
  addScanLog: (log: string) => void;
  clearScanLogs: () => void;
  resetScanControl: () => void;
  incrementHistoryVersion: () => void;
}

export interface UIState {
  historySelectedDate: string | null;
  setHistorySelectedDate: (date: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  historySelectedDate: null,
  setHistorySelectedDate: (date) => set({ historySelectedDate: date })
}))

export const useScannerStore = create<ScannerState>((set) => ({
  running: false,
  paused: false,
  status: 'idle',
  stopRequested: false,
  progressMsg: '',
  scanLogs: [],
  historyVersion: 0,
  setRunning: (running) => set({ running }),
  setPaused: (paused) => set((state) => {
    if (state.stopRequested) {
      return { paused: false, status: 'stopping' };
    }
    return {
      paused,
      status: paused ? 'paused' : (state.status === 'paused' ? 'processing' : state.status),
    };
  }),
  setStatus: (status) => set({ status }),
  requestStop: () => set({
    stopRequested: true,
    paused: false,
    status: 'stopping',
    progressMsg: '正在停止，等待当前邮件处理完成...',
  }),
  clearStopRequest: () => set({ stopRequested: false }),
  setProgressMsg: (progressMsg) => set((state) => {
    const timeStr = new Date().toLocaleTimeString();
    const formattedLog = `[${timeStr}] ${progressMsg}`;
    const newLogs = [formattedLog, ...state.scanLogs].slice(0, 100);
    return { progressMsg, scanLogs: newLogs };
  }),
  addScanLog: (log) => set((state) => {
    const timeStr = new Date().toLocaleTimeString();
    const formattedLog = `[${timeStr}] ${log}`;
    const newLogs = [formattedLog, ...state.scanLogs].slice(0, 100);
    return { scanLogs: newLogs };
  }),
  clearScanLogs: () => set({ scanLogs: [] }),
  resetScanControl: () => set({ running: false, paused: false, status: 'idle', stopRequested: false, progressMsg: '', scanLogs: [] }),
  incrementHistoryVersion: () => set((state) => ({ historyVersion: state.historyVersion + 1 }))
}))

export function getSortedLLMProviders(): LLMProvider[] {
  const state = useSettingsStore.getState();
  let providers = state.llmProviders;
  if (!providers || providers.length === 0) {
    if (state.apiKey || state.apiBaseUrl || state.modelName) {
      providers = [{
        id: 'default-provider',
        name: '默认模型服务商',
        apiBaseUrl: state.apiBaseUrl || 'https://api.openai.com/v1',
        apiKey: state.apiKey || '',
        modelName: state.modelName || 'gpt-4o',
        enabled: true,
        priority: 1
      }];
      setTimeout(() => {
        useSettingsStore.getState().setLLMProviders(providers!);
      }, 0);
    } else {
      return [];
    }
  }
  return [...providers].sort((a, b) => a.priority - b.priority);
}

export function getEffectiveFocus(): string {
  const state = useSettingsStore.getState();
  if (state.promptMode === 'auto') {
    return state.autoOptimizedFocus || state.staticPersonalFocus || state.personalFocus || '关注内容的核心逻辑和可操作的待办事项。';
  }
  return state.staticPersonalFocus || state.personalFocus || '关注内容的核心逻辑和可操作的待办事项。';
}


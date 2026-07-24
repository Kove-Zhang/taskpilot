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
}

interface SettingsState {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  personalFocus: string;
  notionApiKey: string;
  notionDatabaseId: string;
  enableLogging: boolean;
  globalShortcut: string;
  notionProperties: NotionProperty[];
  fieldMappings: Record<string, FieldMapping>;
  tokenLimit: number;
  enableReasoning: boolean;
  emailConfig: EmailConfig;
  setApiSettings: (baseUrl: string, key: string, model: string) => void;
  setPersonalFocus: (focus: string) => void;
  setNotionSettings: (key: string, dbId: string) => void;
  setEnableLogging: (enable: boolean) => void;
  setGlobalShortcut: (shortcut: string) => void;
  setNotionProperties: (props: NotionProperty[]) => void;
  setFieldMapping: (notionPropId: string, mapping: FieldMapping) => void;
  setTokenLimit: (limit: number) => void;
  setEnableReasoning: (enable: boolean) => void;
  setEmailConfig: (config: Partial<EmailConfig>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o',
      personalFocus: '关注内容的核心逻辑和可操作的待办事项。',
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
        autoSyncToNotion: false
      },
      setApiSettings: (apiBaseUrl, apiKey, modelName) => set({ apiBaseUrl, apiKey, modelName }),
      setPersonalFocus: (personalFocus) => set({ personalFocus }),
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
    }),
    {
      name: 'task-pilot-settings',
      storage: createJSONStorage(() => secureStorage),
    }
  )
)

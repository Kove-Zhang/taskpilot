import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

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
  setApiSettings: (baseUrl: string, key: string, model: string) => void;
  setPersonalFocus: (focus: string) => void;
  setNotionSettings: (key: string, dbId: string) => void;
  setEnableLogging: (enable: boolean) => void;
  setGlobalShortcut: (shortcut: string) => void;
  setNotionProperties: (props: NotionProperty[]) => void;
  setFieldMapping: (notionPropId: string, mapping: FieldMapping) => void;
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
      setApiSettings: (baseUrl, key, model) => set({ apiBaseUrl: baseUrl, apiKey: key, modelName: model }),
      setPersonalFocus: (focus) => set({ personalFocus: focus }),
      setNotionSettings: (key, dbId) => set({ notionApiKey: key, notionDatabaseId: dbId }),
      setEnableLogging: (enable) => set({ enableLogging: enable }),
      setGlobalShortcut: (shortcut) => set({ globalShortcut: shortcut }),
      setNotionProperties: (props) => set({ notionProperties: props }),
      setFieldMapping: (id, mapping) => set((state) => ({
        fieldMappings: { ...state.fieldMappings, [id]: mapping }
      })),
    }),
    {
      name: 'task-pilot-settings',
      storage: createJSONStorage(() => localStorage),
    }
  )
)

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import { LazyStore } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import type { ProviderProfile } from './lib/llm/types'
import { assertValidProviderProfile, createProviderProfilesFromLegacy, normalizeProviderProfile } from './lib/llm/providerProfiles'
import type { LegacyProviderConfig } from './lib/llm/providerProfiles'

const tauriStore = new LazyStore('settings.json');

export const SETTINGS_PERSIST_VERSION = 7
export const DEFAULT_MAX_INPUT_CHARS = 8_000
export const MAX_FOCUS_VERSIONS = 10

export type FocusCandidateSource = 'explicit-feedback' | 'history-learning'
export type FocusCandidateStatus = 'candidate' | 'active' | 'rejected' | 'rolled-back'

export interface FocusCandidate {
  id: string
  source: FocusCandidateSource
  createdAt: number
  baseFocusVersion: number
  content: string
  diffSummary: string
  validation: { passed: boolean; reasons: string[] }
  score?: number
  status: FocusCandidateStatus
}

export interface FocusVersion {
  version: number
  content: string
  sourceCandidateId?: string
  activatedAt: number
}

export interface CreateFocusCandidateInput {
  source: FocusCandidateSource
  content: string
  diffSummary: string
  validation: { passed: boolean; reasons: string[] }
  score?: number
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function isLegacyProviderConfig(value: unknown): value is LegacyProviderConfig {
  const record = asRecord(value)
  return record !== null
    && typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.apiBaseUrl === 'string'
    && typeof record.modelName === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.priority === 'number'
}

interface PersistedLegacyProvider extends LegacyProviderConfig {
  apiKey: string
}

function normalizePersistedLegacyProvider(value: unknown): PersistedLegacyProvider | null {
  if (!isLegacyProviderConfig(value)) return null
  const record = asRecord(value)
  return {
    ...value,
    apiKey: typeof record?.apiKey === 'string' ? record.apiKey : '',
  }
}

function getLegacyProvidersFromPersistedState(state: UnknownRecord): PersistedLegacyProvider[] {
  if (Array.isArray(state.llmProviders)) {
    return state.llmProviders
      .map(normalizePersistedLegacyProvider)
      .filter((provider): provider is PersistedLegacyProvider => provider !== null)
  }

  const apiBaseUrl = typeof state.apiBaseUrl === 'string' ? state.apiBaseUrl : ''
  const apiKey = typeof state.apiKey === 'string' ? state.apiKey : ''
  const modelName = typeof state.modelName === 'string' ? state.modelName : ''
  if (!apiBaseUrl && !apiKey && !modelName) return []

  return [{
    id: 'default-provider',
    name: '默认模型服务商',
    apiBaseUrl: apiBaseUrl || 'https://api.openai.com/v1',
    apiKey,
    modelName: modelName || 'gpt-4o',
    enabled: true,
    priority: 1,
  }]
}

function getPersistedMaxInputChars(state: UnknownRecord): number {
  const candidate = typeof state.maxInputChars === 'number' ? state.maxInputChars : state.tokenLimit
  return Number.isFinite(candidate) && typeof candidate === 'number' && candidate > 0
    ? Math.floor(candidate)
    : DEFAULT_MAX_INPUT_CHARS
}

function isFocusCandidate(value: unknown): value is FocusCandidate {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || typeof record.content !== 'string' || typeof record.diffSummary !== 'string') return false
  if (record.source !== 'explicit-feedback' && record.source !== 'history-learning') return false
  if (record.status !== 'candidate' && record.status !== 'active' && record.status !== 'rejected' && record.status !== 'rolled-back') return false
  if (typeof record.createdAt !== 'number' || typeof record.baseFocusVersion !== 'number') return false
  const validation = asRecord(record.validation)
  return validation !== null
    && typeof validation.passed === 'boolean'
    && Array.isArray(validation.reasons)
    && validation.reasons.every((reason) => typeof reason === 'string')
}

function isFocusVersion(value: unknown): value is FocusVersion {
  const record = asRecord(value)
  return record !== null
    && typeof record.version === 'number'
    && typeof record.content === 'string'
    && typeof record.activatedAt === 'number'
    && (record.sourceCandidateId === undefined || typeof record.sourceCandidateId === 'string')
}

type PersistedEmailFilter = Partial<EmailScanFilter> | null | undefined

function normalizeEmailScanFilter(value: PersistedEmailFilter, legacyUnreadOnly: boolean): EmailScanFilter {
  const filter = asRecord(value)
  const readState = filter?.readState === 'read' || filter?.readState === 'unread' || filter?.readState === 'all'
    ? filter.readState
    : (legacyUnreadOnly ? 'unread' : 'all')
  const systemFlags = Array.isArray(filter?.systemFlags)
    ? filter.systemFlags.filter((flag): flag is EmailSystemFlag => EMAIL_SYSTEM_FLAGS.includes(flag as EmailSystemFlag))
    : []
  const keywords = Array.isArray(filter?.keywords)
    ? filter.keywords.filter((keyword): keyword is string => typeof keyword === 'string').map((keyword) => keyword.trim()).filter(Boolean)
    : []
  const excludeKeywords = Array.isArray(filter?.excludeKeywords)
    ? filter.excludeKeywords.filter((keyword): keyword is string => typeof keyword === 'string').map((keyword) => keyword.trim()).filter(Boolean)
    : []
  return { readState, systemFlags: [...new Set(systemFlags)], keywords: [...new Set(keywords)], excludeKeywords: [...new Set(excludeKeywords)] }
}

function normalizePersistedEmailConfig(value: unknown): UnknownRecord | null {
  const config = asRecord(value)
  if (!config) return null
  const legacyAutoUnreadOnly = config.autoUnreadOnly !== false
  const legacyManualUnreadOnly = config.manualUnreadOnly === true
  return {
    ...config,
    autoScanFilter: normalizeEmailScanFilter(config.autoScanFilter as PersistedEmailFilter, legacyAutoUnreadOnly),
    manualScanFilter: normalizeEmailScanFilter(config.manualScanFilter as PersistedEmailFilter, legacyManualUnreadOnly),
  }
}

function getPersistedFocusCandidates(state: UnknownRecord): FocusCandidate[] {
  if (!Array.isArray(state.focusCandidates)) return []
  return state.focusCandidates.filter(isFocusCandidate).slice(-MAX_FOCUS_VERSIONS)
}

function getPersistedFocusVersions(state: UnknownRecord): FocusVersion[] {
  if (!Array.isArray(state.focusVersions)) return []
  return state.focusVersions.filter(isFocusVersion).sort((a, b) => a.version - b.version).slice(-MAX_FOCUS_VERSIONS)
}

/**
 * Migrates persisted settings without moving secrets into ProviderProfile.
 * ProviderProfile only stores protocol/capability metadata; API keys remain in
 * the legacy provider entries handled by secureStorage.
 */
export function migrateSettingsState(persistedState: unknown, version: number): UnknownRecord {
  const parsedState = asRecord(persistedState)
  const state: UnknownRecord = parsedState ? { ...parsedState } : {}
  const existingProfiles = Array.isArray(state.providerProfiles)
    ? state.providerProfiles
      .map((profile) => normalizeProviderProfile(profile))
      .filter((profile): profile is ProviderProfile => profile !== null)
    : []
  const legacyProviders = getLegacyProvidersFromPersistedState(state)
  const focusCandidates = getPersistedFocusCandidates(state)
  const focusVersions = getPersistedFocusVersions(state)
  const activeFocusVersion = typeof state.activeFocusVersion === 'number' && Number.isFinite(state.activeFocusVersion)
    ? Math.max(0, Math.floor(state.activeFocusVersion))
    : (focusVersions.at(-1)?.version ?? 0)

  const maxInputChars = getPersistedMaxInputChars(state)
  const experimentalLLMRoutingEnabled = typeof state.experimentalLLMRoutingEnabled === 'boolean' ? state.experimentalLLMRoutingEnabled : false
  const experimentalProviderHealthEnabled = typeof state.experimentalProviderHealthEnabled === 'boolean' ? state.experimentalProviderHealthEnabled : false
  const enablePromptLogging = typeof state.enablePromptLogging === 'boolean' ? state.enablePromptLogging : false
  const normalizedEmailConfig = normalizePersistedEmailConfig(state.emailConfig)
  if (version >= SETTINGS_PERSIST_VERSION && Array.isArray(state.providerProfiles)) {
    return {
      ...state,
      maxInputChars,
      // Keep the legacy mirror during the migration window for older callers.
      tokenLimit: maxInputChars,
      focusCandidates,
      focusVersions,
      activeFocusVersion,
      experimentalLLMRoutingEnabled,
      experimentalProviderHealthEnabled,
      enablePromptLogging,
      providerProfiles: existingProfiles,
      ...(normalizedEmailConfig ? { emailConfig: normalizedEmailConfig } : {}),
    }
  }

  const migratedState: UnknownRecord = {
    ...state,
    maxInputChars,
    tokenLimit: maxInputChars,
    focusCandidates,
    focusVersions,
    activeFocusVersion,
    experimentalLLMRoutingEnabled,
    experimentalProviderHealthEnabled,
    enablePromptLogging,
    providerProfiles: createProviderProfilesFromLegacy(legacyProviders, existingProfiles),
    ...(normalizedEmailConfig ? { emailConfig: normalizedEmailConfig } : {}),
  }

  if (!Array.isArray(state.llmProviders) && legacyProviders.length > 0) {
    migratedState.llmProviders = legacyProviders
  }

  return migratedState
}

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

export type EmailReadState = 'all' | 'unread' | 'read'
export const EMAIL_SYSTEM_FLAGS = ['flagged', 'unflagged', 'answered', 'unanswered', 'draft', 'deleted', 'recent'] as const
export type EmailSystemFlag = typeof EMAIL_SYSTEM_FLAGS[number]

export interface EmailScanFilter {
  readState: EmailReadState
  systemFlags: EmailSystemFlag[]
  keywords: string[]
  excludeKeywords: string[]
}

export const DEFAULT_EMAIL_SCAN_FILTER: EmailScanFilter = {
  readState: 'all',
  systemFlags: [],
  keywords: [],
  excludeKeywords: [],
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
  /** New structured filters. Legacy unread booleans remain for persisted-state compatibility. */
  autoScanFilter?: EmailScanFilter;
  manualScanFilter?: EmailScanFilter;
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
  focusCandidates: FocusCandidate[];
  focusVersions: FocusVersion[];
  activeFocusVersion: number;
  notionApiKey: string;
  notionDatabaseId: string;
  enableLogging: boolean;
  enablePromptLogging: boolean;
  globalShortcut: string;
  notionProperties: NotionProperty[];
  fieldMappings: Record<string, FieldMapping>;
  /** Maximum input characters; tokenLimit is retained as a compatibility mirror. */
  maxInputChars: number;
  tokenLimit: number;
  enableReasoning: boolean;
  emailConfig: EmailConfig;
  llmProviders?: LLMProvider[];
  providerProfiles: ProviderProfile[];
  enableFailover: boolean;
  failoverRetryCount: number;
  failoverOnAuthError: boolean;
  /** Release-gated experimental controls; disabling them keeps legacy routing/health behavior. */
  experimentalLLMRoutingEnabled: boolean;
  experimentalProviderHealthEnabled: boolean;
  isWindowMode: boolean;
  setLLMProviders: (providers: LLMProvider[]) => void;
  setProviderProfiles: (profiles: ProviderProfile[]) => void;
  setFailoverConfig: (enable: boolean, retryCount: number, failoverOnAuthError: boolean) => void;
  setExperimentalLLMFlags: (routingEnabled: boolean, healthEnabled: boolean) => void;
  setApiSettings: (baseUrl: string, key: string, model: string) => void;
  setPersonalFocus: (focus: string) => void; // Legacy
  setPromptMode: (mode: 'static' | 'auto') => void;
  setStaticFocus: (focus: string) => void;
  setAutoOptimizedFocus: (focus: string) => void;
  createFocusCandidate: (input: CreateFocusCandidateInput) => FocusCandidate;
  activateFocusCandidate: (candidateId: string) => boolean;
  rejectFocusCandidate: (candidateId: string) => void;
  rollbackFocusVersion: (version: number) => boolean;
  setNotionSettings: (key: string, dbId: string) => void;
  setEnableLogging: (enable: boolean) => void;
  setEnablePromptLogging: (enable: boolean) => void;
  setGlobalShortcut: (shortcut: string) => void;
  setNotionProperties: (props: NotionProperty[]) => void;
  setFieldMapping: (notionPropId: string, mapping: FieldMapping) => void;
  setMaxInputChars: (limit: number) => void;
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
      focusCandidates: [],
      focusVersions: [],
      activeFocusVersion: 0,
      notionApiKey: '',
      notionDatabaseId: '',
      enableLogging: false,
      enablePromptLogging: false,
      globalShortcut: 'Alt+Space',
      notionProperties: [],
      fieldMappings: {},
      maxInputChars: DEFAULT_MAX_INPUT_CHARS,
      tokenLimit: DEFAULT_MAX_INPUT_CHARS,
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
        maxEmailsPerFolder: 50,
        autoScanFilter: { ...DEFAULT_EMAIL_SCAN_FILTER, readState: 'unread' },
        manualScanFilter: { ...DEFAULT_EMAIL_SCAN_FILTER },
      },
      enableFailover: true,
      failoverRetryCount: 1,
      failoverOnAuthError: false,
      experimentalLLMRoutingEnabled: false,
      experimentalProviderHealthEnabled: false,
      isWindowMode: false,
      providerProfiles: [],
      setApiSettings: (apiBaseUrl, apiKey, modelName) => set((state) => {
        const providers = state.llmProviders && state.llmProviders.length > 0
          ? state.llmProviders.map((p, idx) => idx === 0 ? { ...p, apiBaseUrl, apiKey, modelName } : p)
          : [{ id: 'default-provider', name: '默认模型服务商', apiBaseUrl, apiKey, modelName, enabled: true, priority: 1 }];
        return {
          apiBaseUrl,
          apiKey,
          modelName,
          llmProviders: providers,
          providerProfiles: createProviderProfilesFromLegacy(providers, state.providerProfiles),
        };
      }),
      setLLMProviders: (llmProviders) => set((state) => {
        const sorted = [...llmProviders].sort((a, b) => a.priority - b.priority);
        const top = sorted.find(p => p.enabled) || sorted[0];
        const providerProfiles = createProviderProfilesFromLegacy(llmProviders, state.providerProfiles);
        if (top) {
          return {
            llmProviders,
            providerProfiles,
            apiBaseUrl: top.apiBaseUrl,
            apiKey: top.apiKey,
            modelName: top.modelName,
          };
        }
        return { llmProviders, providerProfiles };
      }),
      setProviderProfiles: (providerProfiles) => set({ providerProfiles: providerProfiles.map(assertValidProviderProfile) }),
      setFailoverConfig: (enableFailover, failoverRetryCount, failoverOnAuthError) => set({ enableFailover, failoverRetryCount, failoverOnAuthError }),
      setExperimentalLLMFlags: (experimentalLLMRoutingEnabled, experimentalProviderHealthEnabled) => set({ experimentalLLMRoutingEnabled, experimentalProviderHealthEnabled }),
      setPersonalFocus: (personalFocus) => set({ personalFocus }),
      setPromptMode: (promptMode) => set({ promptMode }),
      setStaticFocus: (staticPersonalFocus) => set({ 
        staticPersonalFocus, 
        staticFocusUpdatedAt: Date.now() 
      }),
      setAutoOptimizedFocus: (autoOptimizedFocus) => set({
        autoOptimizedFocus,
        autoOptimizedUpdatedAt: Date.now(),
      }),
      createFocusCandidate: (input) => {
        let created: FocusCandidate | undefined
        set((state) => {
          const now = Date.now()
          const maxVersion = state.focusVersions.reduce((max, item) => Math.max(max, item.version), 0)
          created = {
            id: `focus-candidate-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            source: input.source,
            createdAt: now,
            baseFocusVersion: state.activeFocusVersion || maxVersion,
            content: input.content.trim().slice(0, 8_000),
            diffSummary: input.diffSummary.trim().slice(0, 800),
            validation: {
              passed: input.validation.passed,
              reasons: input.validation.reasons.map((reason) => String(reason).slice(0, 160)).slice(0, 10),
            },
            ...(input.score === undefined || !Number.isFinite(input.score) ? {} : { score: input.score }),
            status: 'candidate',
          }
          return { focusCandidates: [...state.focusCandidates, created].slice(-MAX_FOCUS_VERSIONS) }
        })
        return created!
      },
      activateFocusCandidate: (candidateId) => {
        let activated = false
        set((state) => {
          const candidate = state.focusCandidates.find((item) => item.id === candidateId && item.status === 'candidate')
          if (!candidate || !candidate.validation.passed || !candidate.content.trim()) return state
          const now = Date.now()
          let versions = [...state.focusVersions]
          let nextVersion = versions.reduce((max, item) => Math.max(max, item.version), 0) + 1
          if (versions.length === 0 && state.autoOptimizedFocus.trim()) {
            versions = [{
              version: nextVersion,
              content: state.autoOptimizedFocus,
              activatedAt: state.autoOptimizedUpdatedAt || now,
            }]
            nextVersion += 1
          }
          const newVersion: FocusVersion = {
            version: nextVersion,
            content: candidate.content,
            sourceCandidateId: candidate.id,
            activatedAt: now,
          }
          activated = true
          const candidates = state.focusCandidates.map((item) => item.id === candidate.id
            ? { ...item, status: 'active' as const }
            : item.status === 'active' ? { ...item, status: 'rolled-back' as const } : item)
          return {
            focusCandidates: candidates,
            focusVersions: [...versions, newVersion].slice(-MAX_FOCUS_VERSIONS),
            activeFocusVersion: nextVersion,
            autoOptimizedFocus: candidate.content,
            autoOptimizedUpdatedAt: now,
            promptMode: 'auto' as const,
          }
        })
        return activated
      },
      rejectFocusCandidate: (candidateId) => set((state) => ({
        focusCandidates: state.focusCandidates.map((item) => item.id === candidateId && item.status === 'candidate'
          ? { ...item, status: 'rejected' as const }
          : item),
      })),
      rollbackFocusVersion: (version) => {
        let rolledBack = false
        set((state) => {
          const target = state.focusVersions.find((item) => item.version === version)
          if (!target) return state
          rolledBack = true
          const candidates = state.focusCandidates.map((item) => {
            if (item.id === target.sourceCandidateId) return { ...item, status: 'active' as const }
            if (item.status === 'active') return { ...item, status: 'rolled-back' as const }
            return item
          })
          return {
            focusCandidates: candidates,
            activeFocusVersion: target.version,
            autoOptimizedFocus: target.content,
            autoOptimizedUpdatedAt: Date.now(),
            promptMode: 'auto' as const,
          }
        })
        return rolledBack
      },
      setNotionSettings: (notionApiKey, notionDatabaseId) => set({ notionApiKey, notionDatabaseId }),
      setEnableLogging: (enableLogging) => set({ enableLogging }),
      setEnablePromptLogging: (enablePromptLogging) => set({ enablePromptLogging }),
      setGlobalShortcut: (globalShortcut) => set({ globalShortcut }),
      setNotionProperties: (props) => set({ notionProperties: props }),
      setFieldMapping: (id, mapping) => set((state) => ({
        fieldMappings: {
          ...state.fieldMappings,
          [id]: mapping
        }
      })),
      setMaxInputChars: (maxInputChars) => set({ maxInputChars, tokenLimit: maxInputChars }),
      setTokenLimit: (tokenLimit) => set({ maxInputChars: tokenLimit, tokenLimit }),
      setEnableReasoning: (enableReasoning) => set({ enableReasoning }),
      setEmailConfig: (config: Partial<EmailConfig>) => set((state) => ({ 
        emailConfig: { ...state.emailConfig, ...config } 
      })),
      setWindowMode: (isWindowMode) => set({ isWindowMode }),
    }),
    {
      name: 'task-pilot-settings',
      version: SETTINGS_PERSIST_VERSION,
      storage: createJSONStorage(() => secureStorage),
      migrate: (persistedState, version) => migrateSettingsState(persistedState, version),
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

export function getProviderProfiles(): ProviderProfile[] {
  const state = useSettingsStore.getState()
  const providers = getSortedLLMProviders()
  return createProviderProfilesFromLegacy(providers, state.providerProfiles).sort((a, b) => a.priority - b.priority)
}

export function getEffectiveFocus(): string {
  const state = useSettingsStore.getState();
  if (state.promptMode === 'auto') {
    return state.autoOptimizedFocus || state.staticPersonalFocus || state.personalFocus || '关注内容的核心逻辑和可操作的待办事项。';
  }
  return state.staticPersonalFocus || state.personalFocus || '关注内容的核心逻辑和可操作的待办事项。';
}


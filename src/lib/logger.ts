import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

type PromptContentPart = Record<string, unknown>;

type PromptMessage = {
  role?: unknown;
  content?: unknown;
};

function sanitizePromptContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  return content.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const part = item as PromptContentPart;
    const type = typeof part.type === 'string' ? part.type : 'unknown';
    if (type === 'text') {
      return { type, text: String(part.text ?? '') };
    }
    if (type === 'image_url') {
      return { type, image_url: '[Image data omitted]' };
    }
    return { type };
  });
}

/**
 * Keeps prompt logging separate from ordinary diagnostics. The setting is
 * intentionally checked here, at the final log boundary, so callers cannot
 * accidentally leak prompts when the feature is disabled.
 */
function sanitizePromptData(data: { model?: unknown; messages?: unknown; system?: unknown }): Record<string, unknown> {
  const messages = Array.isArray(data.messages)
    ? data.messages.map((message) => {
        const item = (message && typeof message === 'object' ? message : {}) as PromptMessage;
        return {
          role: item.role,
          content: sanitizePromptContent(item.content),
        };
      })
    : [];

  return {
    promptLogging: true,
    warning: '提示词可能包含敏感业务数据，仅用于本地排障。',
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.system !== undefined ? { system: data.system } : {}),
    messages,
  };
}

function serializeLogData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Error) {
    return JSON.stringify({ message: data.message, stack: data.stack, name: data.name }, null, 2);
  }
  return JSON.stringify(data, (_key, value) => {
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack, name: value.name };
    }
    return value;
  }, 2);
}

async function writeLog(level: LogLevel, msg: string, data?: unknown): Promise<void> {
  let serializedData = '';
  if (data !== undefined && data !== null) {
    serializedData = serializeLogData(data);
  }

  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const message = `[${timestamp}] [${level}] ${msg} ${serializedData ? '\n' + serializedData : ''}`;

  if (level === 'ERROR') {
    console.error(message);
  } else {
    console.log(message);
  }

  try {
    await invoke('write_log', { message });
  } catch (e) {
    console.error('Failed to write log to file:', e);
  }
}

export async function logMessage(level: LogLevel, msg: string, data?: unknown): Promise<void> {
  if (!useSettingsStore.getState().enableLogging) return;
  await writeLog(level, msg, data);
}

export async function logPromptSubmission(
  msg: string,
  data: { model?: unknown; messages?: unknown; system?: unknown },
): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.enableLogging || !settings.enablePromptLogging) return;
  await writeLog('INFO', msg, sanitizePromptData(data));
}

export const logger = {
  info: (msg: string, data?: unknown) => logMessage('INFO', msg, data),
  warn: (msg: string, data?: unknown) => logMessage('WARN', msg, data),
  error: (msg: string, data?: unknown) => logMessage('ERROR', msg, data),
  prompt: logPromptSubmission,
};

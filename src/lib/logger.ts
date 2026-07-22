import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store';

export async function logMessage(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: any) {
  const enableLogging = useSettingsStore.getState().enableLogging;
  if (!enableLogging) return;

  const serializedData = data ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) : '';
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const message = `[${timestamp}] [${level}] ${msg} ${serializedData ? '\\n' + serializedData : ''}`;
  
  // Output to console as well
  if (level === 'ERROR') {
    console.error(message);
  } else {
    console.log(message);
  }

  try {
    await invoke('write_log', { message });
  } catch (e) {
    console.error("Failed to write log to file:", e);
  }
}

export const logger = {
  info: (msg: string, data?: any) => logMessage('INFO', msg, data),
  warn: (msg: string, data?: any) => logMessage('WARN', msg, data),
  error: (msg: string, data?: any) => logMessage('ERROR', msg, data),
};

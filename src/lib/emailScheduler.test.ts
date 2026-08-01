import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { forceRunEmailScanner } from './emailScheduler'
import { useScannerStore, useSettingsStore } from '../store'

const baseConfig = {
  host: 'imap.example.test',
  port: 993,
  ssl: true,
  user: 'user@example.test',
  pass: 'test-password',
  targetFolder: 'INBOX',
  scheduleDays: [0, 1, 2, 3, 4, 5, 6],
  scheduleTime: 'every_1h',
  markAsRead: false,
  retryCount: 0,
  enabled: true,
  autoSyncToNotion: false,
  autoReadDays: 2,
  manualReadDays: 9,
}

describe('email scheduler P1 regression cases', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    useSettingsStore.setState({ emailConfig: baseConfig })
    useScannerStore.setState({
      running: false,
      paused: false,
      stopRequested: false,
      progressMsg: '',
      scanLogs: [],
      historyVersion: 0,
    })
  })

  it('uses manual scan scope and stores malformed mail as a terminal failed record', async () => {
    const uid = 910_001
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'fetch_emails') {
        return [{
          uid,
          uid_validity: 101,
          sender: 'sender@example.test',
          subject: 'Malformed message',
          date: '2026-08-01T00:00:00Z',
          body_text: '',
          parse_error: '邮件超过允许的大小',
        }] as never
      }
      return undefined as never
    })

    await forceRunEmailScanner(true)

    const fetchCall = vi.mocked(invoke).mock.calls.find(([command]) => command === 'fetch_emails')
    expect(fetchCall?.[1]).toMatchObject({ request: { unreadOnly: false, sinceDays: 9, folder: 'INBOX' } })
    expect(useScannerStore.getState()).toMatchObject({ running: false, progressMsg: '扫描任务完成', historyVersion: 1 })
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'mark_email_read')).toBe(false)
  })

  it('treats the same UID under a new UIDVALIDITY as a new mail item', async () => {
    const uid = 910_002
    let uidValidity = 201
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'fetch_emails') {
        return [{
          uid,
          uid_validity: uidValidity,
          sender: 'sender@example.test',
          subject: 'Changed mailbox generation',
          date: '2026-08-01T00:00:00Z',
          body_text: '',
          parse_error: 'MIME 解析失败',
        }] as never
      }
      return undefined as never
    })

    await forceRunEmailScanner(false)
    uidValidity = 202
    await forceRunEmailScanner(false)

    expect(useScannerStore.getState().historyVersion).toBe(2)
    const requests = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === 'fetch_emails')
      .map(([, args]) => (args as { request: { unreadOnly: boolean; sinceDays: number } }).request)
    expect(requests).toEqual([
      expect.objectContaining({ unreadOnly: true, sinceDays: 2 }),
      expect.objectContaining({ unreadOnly: true, sinceDays: 2 }),
    ])
  })
})

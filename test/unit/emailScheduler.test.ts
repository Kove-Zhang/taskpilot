import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from '../../src/store'

describe('Email Config State Tests', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailConfig: {
        host: 'imap.test.com',
        port: 993,
        ssl: true,
        user: 'test',
        pass: 'pass',
        targetFolder: 'INBOX',
        scheduleDays: [1, 2, 3],
        scheduleTime: 'every_1h',
        markAsRead: false,
        retryCount: 1,
        enabled: true,
        autoSyncToNotion: false,
        autoUnreadOnly: true,
        manualUnreadOnly: false,
        autoReadDays: 3,
        manualReadDays: 7,
        maxEmailsPerFolder: 50
      }
    })
  })

  it('should enable and disable email scheduling', () => {
    const { emailConfig, setEmailConfig } = useSettingsStore.getState()
    expect(emailConfig.enabled).toBe(true)
    
    setEmailConfig({ enabled: false })
    
    expect(useSettingsStore.getState().emailConfig.enabled).toBe(false)
  })
})

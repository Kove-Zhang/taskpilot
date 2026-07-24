import { describe, it, expect, vi, beforeEach } from 'vitest'
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
        enabled: true
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

import { describe, it } from 'mocha'
import { expect } from '@wdio/globals'

describe('Task Pilot desktop smoke test', () => {
  it('loads the main window and can open the settings panel without external credentials', async () => {
    const body = await $('body')
    await body.waitForExist({ timeout: 10_000 })

    const settingsButton = await $('[data-testid="open-settings"]')
    await expect(settingsButton).toBeExisting()
    await settingsButton.click()

    const apiBaseUrlInput = await $('[data-testid="settings-api-base-url"]')
    const apiKeyInput = await $('[data-testid="settings-api-key"]')
    const saveButton = await $('[data-testid="save-settings"]')

    await expect(apiBaseUrlInput).toBeExisting()
    await expect(apiKeyInput).toBeExisting()
    await expect(saveButton).toBeExisting()
  })
})

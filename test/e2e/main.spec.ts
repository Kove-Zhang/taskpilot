import { expect } from '@wdio/globals'

describe('Task Pilot E2E', () => {
    it('should set API credentials and extract TODO successfully', async () => {
        // 1. Wait for the app to load
        const body = await $('body')
        await body.waitForExist({ timeout: 10000 })
        
        // 2. Open Settings Panel
        // Assuming there is a settings button in the UI
        const settingsBtn = await $('button[title="设置"]')
        if (await settingsBtn.isExisting()) {
            await settingsBtn.click()
        }

        // 3. Inject Real API Credentials
        const apiBaseUrlInput = await $('input[placeholder*="API Base URL"]')
        await apiBaseUrlInput.setValue('https://ai.chinatowercom.cn:30080/v1')

        const apiKeyInput = await $('input[placeholder*="API Key"]')
        await apiKeyInput.setValue('f27bd2b1-ebf6-4452-8510-96172e0fea87')

        const modelInput = await $('input[placeholder*="模型名称"]')
        await modelInput.setValue('qwen3.7-plus')
        
        // 4. Save and Close Settings
        // Click outside or explicit save button depending on UI
        const saveBtn = await $('button=保存')
        if (await saveBtn.isExisting()) {
            await saveBtn.click()
        }
        
        // 5. Test main flow (Text Extraction)
        const textarea = await $('textarea[placeholder*="输入待办"]')
        await textarea.setValue('安排明早10点开周会')
        
        const extractBtn = await $('button=AI 提取')
        await extractBtn.click()
        
        // 6. Assert extraction result
        // Wait for loader to disappear and card to appear
        const card = await $('.card-container') // Update selector based on actual implementation
        await card.waitForExist({ timeout: 15000 })
        
        const textContent = await card.getText()
        expect(textContent).toContain('周会')

        // 7. Test AI Writing function
        const writeInput = await $('input[placeholder*="基于这些待办写"]')
        await writeInput.setValue('请帮我写一封短邮件')

        const generateBtn = await $('button=生成')
        await generateBtn.click()

        // Wait for writing result to appear
        const writingResult = await $('button=复制内容')
        await writingResult.waitForExist({ timeout: 15000 })
    })
})

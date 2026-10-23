import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { startFixtureServer } from '../pi-sdk/wire'

for (const { kind, good, bad, label, button, success } of [
  { kind: 'chat', good: 'text', bad: 'empty-text', label: '文字流式', button: '测试文字', success: '文字增量，流式响应正常结束' },
  { kind: 'tools', good: 'tool', bad: 'unknown-tool', label: '工具调用', button: '测试工具', success: '已验证指定工具调用及参数' },
  { kind: 'vision', good: 'vision-correct', bad: 'vision-wrong', label: '图片识别', button: '测试视觉', success: '已正确识别测试图片' }
] as const) {
  for (const scenario of [good, bad, 'http-error'] as const) {
    test(`${kind} test button makes a real SSE request and shows ${scenario}`, async () => {
      const server = await startFixtureServer('openai-responses', scenario)
      const directory = mkdtempSync(join(tmpdir(), 'her-model-connection-'))
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
      const app = await _electron.launch({ ...(process.env.HER_TEST_APP_EXECUTABLE ? { executablePath: process.env.HER_TEST_APP_EXECUTABLE, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
      try {
        const page = await app.firstWindow()
        await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
        await page.evaluate(async baseUrl => {
          await window.her.saveProfile({
            name: 'SSE fixture', protocol: 'openai-responses', baseUrl: baseUrl + '/prefix/v1',
            model: 'test-model', contextWindow: 128000, authMethod: 'api-key', apiKey: 'synthetic-credential-fixture'
          })
        }, server.baseUrl)
        await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
        await page.getByRole('button', { name: button, exact: true }).click()
        const row = page.locator('.test-row').filter({ hasText: label })
        await expect(row.locator('.test-badge')).toHaveText(scenario === good ? '已验证' : '失败')
        if (scenario === good) await expect(row).toContainText(success)
        if (scenario === 'http-error') await expect(row).toContainText('认证失败（HTTP 401）')
        expect(server.requests).toHaveLength(1)
        expect(server.requests[0].url).toBe('/prefix/v1/responses')
        expect(server.requests[0].body).toMatchObject({ stream: true, model: 'test-model' })
        await page.reload()
        await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
        await expect(page.locator('.test-row').filter({ hasText: label }).locator('.test-badge'))
          .toHaveText(scenario === good ? '已验证' : '失败')
      } finally {
        await app.close()
        await server.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
}

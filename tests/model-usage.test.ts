import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

describe('persisted task token usage', () => {
  for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
    it.each(['text', 'no-usage'] as const)(`${protocol}: %s retains reported counts or explicit unknowns`, async scenario => {
      const server = await startFixtureServer(protocol, scenario); cleanup.push(server.close)
      const f = harness()
      const profile = await f.profiles.save({ name: 'p', protocol, baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
      const sent = await f.send(f.id, profile.id, 'hi')
      await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
      const task = f.store.getLatestTask(f.id)!
      const db = new DatabaseSync(join(f.directory, 'her.sqlite'))
      const usage = db.prepare('SELECT input_tokens, output_tokens FROM task_usage WHERE task_id = ?').get(task.id)
      db.close()
      expect(usage).toEqual(scenario === 'text' ? { input_tokens: 11, output_tokens: 5 } : { input_tokens: null, output_tokens: null })
      expect(f.events.at(-1)?.message).toMatchObject({ usage: scenario === 'text' ? { input: 11, output: 5 } : { input: null, output: null } })
    })
  }
})

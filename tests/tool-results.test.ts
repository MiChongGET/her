import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'

const stores: HerStore[] = []
const directories: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'her-artifacts-'))
  directories.push(directory)
  const store = new HerStore(join(directory, 'her.sqlite'))
  stores.push(store)
  const conversation = store.createConversation()
  return { directory, store, conversation, context: {
    runId: 'run', conversationId: conversation.id, callId: 'call', signal: new AbortController().signal
  } }
}

describe('structured tool results', () => {
  it('normalizes legacy strings and preserves supported blocks and metadata', async () => {
    const { normalizeToolResult } = await import('../src/core/tools/results')
    expect(normalizeToolResult('old result')).toEqual({ content: [{ type: 'text', text: 'old result' }] })
    const result = { content: [
      { type: 'text' as const, text: 'caption' },
      { type: 'image' as const, artifactId: 'image-id', mimeType: 'image/png' },
      { type: 'resource_link' as const, uri: 'https://example.com', name: 'source' }
    ], structuredContent: { count: 1 }, meta: { snapshot: 's1' }, isError: true, truncated: true }
    expect(normalizeToolResult(result)).toEqual(result)
  })

  it('marks unsupported blocks as errors instead of silently losing them', async () => {
    const { normalizeToolResult } = await import('../src/core/tools/results')
    const result = normalizeToolResult({ content: [{ type: 'audio', data: 'secret base64' }] } as never)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('audio')
    expect(JSON.stringify(result)).not.toContain('secret base64')
  })

  it('caps total text at 30000 characters and explicitly marks truncation', async () => {
    const { normalizeToolResult } = await import('../src/core/tools/results')
    const result = normalizeToolResult({ content: [{ type: 'text', text: 'a'.repeat(20000) }, { type: 'text', text: 'b'.repeat(20000) }] })
    expect(result.truncated).toBe(true)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toHaveLength(30000)
  })

  it('keeps formatted model text within the limit and tells the model when it was truncated', async () => {
    const { toolResultText } = await import('../src/core/tools/results')
    const text = toolResultText({ content: [{ type: 'text', text: 'a'.repeat(20000) }, { type: 'text', text: 'b'.repeat(20000) }] })
    expect(text.length).toBeLessThanOrEqual(30000)
    expect(text).toContain('truncated')
  })

  it('rejects nontext provider formatting until multimodal support is available', async () => {
    const { toolResultText } = await import('../src/core/tools/results')
    expect(toolResultText({ content: [{ type: 'text', text: 'hello' }] })).toBe('hello')
    expect(() => toolResultText({ content: [{ type: 'image', artifactId: 'a', mimeType: 'image/png' }] })).toThrow(/图片|image|T02/i)
  })
})

describe('tool artifact ownership and persistence', () => {
  it('image_history_uses_artifact_reference', async () => {
    const { ToolArtifactStore } = await import('../src/core/tools/artifacts')
    const { directory, store, conversation, context } = setup()
    const artifacts = new ToolArtifactStore(store)
    const bytes = new Uint8Array([137, 80, 78, 71, 9, 8, 7])
    const reference = await artifacts.put(bytes, { conversationId: conversation.id }, 'image/png')
    store.addMessage({ id: 'assistant', conversationId: conversation.id, role: 'assistant', content: 'observed', status: 'complete', createdAt: new Date().toISOString(), toolCalls: [{ id: 'call', name: 'observe', arguments: {}, result: { content: [{ type: 'image', artifactId: reference.id, mimeType: reference.mimeType }] } }] })
    const history = JSON.stringify(store.getMessages(conversation.id))
    expect(history).toContain(reference.id)
    expect(history).not.toContain(Buffer.from(bytes).toString('base64'))
    expect(history).not.toContain(directory)
    expect(reference).toEqual({ id: expect.any(String), conversationId: conversation.id, mimeType: 'image/png', byteLength: bytes.byteLength })
    expect(await new ToolArtifactStore(store).read(reference.id, context)).toEqual(bytes)
    const file = join(directory, 'tool-artifacts', reference.id)
    expect(readFileSync(file)).toEqual(Buffer.from(bytes))
    unlinkSync(file)
    await expect(artifacts.read(reference.id, context)).rejects.toThrow(/缺失|不存在/)
  })

  it('foreign_conversation_cannot_read_artifact', async () => {
    const { ToolArtifactStore } = await import('../src/core/tools/artifacts')
    const { store, conversation, context } = setup()
    const artifacts = new ToolArtifactStore(store)
    const reference = await artifacts.put(new Uint8Array([1]), { conversationId: conversation.id }, 'image/png')
    const other = store.createConversation()
    await expect(artifacts.read(reference.id, { ...context, conversationId: other.id })).rejects.toThrow(/授权|会话/)
    await expect(artifacts.read('../her.sqlite', context)).rejects.toThrow()
  })

  it('fails closed for source-file artifacts and rejects oversized images and aborted reads', async () => {
    const { ToolArtifactStore } = await import('../src/core/tools/artifacts')
    const { store, conversation, context } = setup()
    const artifacts = new ToolArtifactStore(store)
    await expect(artifacts.put(new Uint8Array([1]), { conversationId: conversation.id, sourceFileId: 'source' }, 'image/png')).rejects.toThrow(/授权/)
    const reference = await artifacts.put(new Uint8Array([1]), { conversationId: conversation.id }, 'image/png')
    await expect(artifacts.put(new Uint8Array(10 * 1024 * 1024 + 1), { conversationId: conversation.id }, 'image/png')).rejects.toThrow(/10 MiB/)
    const controller = new AbortController()
    controller.abort()
    await expect(artifacts.read(reference.id, { ...context, signal: controller.signal })).rejects.toThrow()
  })

  it('cleans dedicated artifact files and metadata when a conversation is purged', async () => {
    const { ToolArtifactStore } = await import('../src/core/tools/artifacts')
    const { store, conversation, context } = setup()
    const artifacts = new ToolArtifactStore(store)
    const own = await artifacts.put(new Uint8Array([1]), { conversationId: conversation.id }, 'image/png')
    const other = store.createConversation()
    const foreign = await artifacts.put(new Uint8Array([2]), { conversationId: other.id }, 'image/png')
    store.trashConversation(conversation.id)
    store.purgeConversation(conversation.id)
    await expect(artifacts.read(own.id, context)).rejects.toThrow()
    expect(await artifacts.read(foreign.id, { ...context, conversationId: other.id })).toEqual(new Uint8Array([2]))
    expect(() => readFileSync(join(store.artifactDirectory, own.id))).toThrow()
  })
})

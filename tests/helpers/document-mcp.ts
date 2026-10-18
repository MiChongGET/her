import { createInterface } from 'node:readline'
const mode = process.argv[2]
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result: unknown
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'document-fixture', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'convert_to_markdown', inputSchema: { type: 'object', required: ['uri'], properties: { uri: { type: 'string', pattern: '^file:' } }, additionalProperties: false }, outputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] } }] }
  else if (request.method === 'tools/call') {
    if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 100))
    const text = 'full extracted text '.repeat(3000)
    result = { content: [{ type: 'text', text }], structuredContent: { result: mode === 'invalid-output' ? 42 : text } }
  } else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})

import type { ToolRegistry } from './types'

const unknownTool = (name: string) => ({ isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }] })

/** Presents several registries as one. A tool name owned by two registries is a bug, never a silent override. */
export function combineRegistries(registries: ToolRegistry[]): ToolRegistry {
  const snapshots = registries.map(registry => registry.snapshot())
  const owners = new Map<string, ToolRegistry>()
  for (const snapshot of snapshots) for (const { name } of snapshot.getDefinitions()) {
    if (owners.has(name)) throw new Error(`工具名称冲突：${name}`)
    owners.set(name, snapshot)
  }
  const combined: ToolRegistry = {
    snapshot: () => combined,
    getDefinitions: () => snapshots.flatMap(snapshot => snapshot.getDefinitions()),
    getRevisions: () => Object.assign({}, ...snapshots.map(snapshot => snapshot.getRevisions())),
    execute: async (name, args, context) => owners.get(name)?.execute(name, args, context) ?? unknownTool(name)
  }
  return combined
}

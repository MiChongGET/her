import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPaths, DATA_ROOT_NAME } from '../src/core/storage/paths'
import { HerStore } from '../src/core/storage/store'

const directories: string[] = []
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
const userData = () => { const d = mkdtempSync(join(tmpdir(), 'her-userdata-')); directories.push(d); return d }
const inside = (root: string, path: string) => { const r = relative(root, path); return !!r && !r.startsWith('..') && !isAbsolute(r) }

describe('data paths', () => {
  it('puts every Her-Pi location under one dedicated root inside the user-data folder', () => {
    const base = userData(), paths = dataPaths(base)
    expect(paths.root).toBe(join(base, DATA_ROOT_NAME))
    for (const path of [paths.database, paths.pi, paths.artifacts, paths.documents]) expect(inside(paths.root, path)).toBe(true)
  })

  it('never resolves to the user-data folder itself, where the old Her kept its files', () => {
    const base = userData(), paths = dataPaths(base)
    for (const path of Object.values(paths)) expect(path).not.toBe(base)
    expect(paths.database).not.toBe(join(base, 'her.sqlite'))
  })

  it('leaves files the old Her wrote in the user-data folder unread and unchanged', () => {
    const base = userData()
    // An old-style database at schema version 7 and a stray old image folder.
    const oldDatabase = join(base, 'her.sqlite')
    const old = new DatabaseSync(oldDatabase); old.exec('CREATE TABLE messages (id TEXT); PRAGMA user_version = 7'); old.close()
    writeFileSync(join(base, 'old-note.txt'), 'old data')
    const before = readFileSync(oldDatabase)
    const paths = dataPaths(base)
    const store = new HerStore(paths.database)   // would throw "unsupported database version 7" if it opened the old file
    store.close()
    expect(readFileSync(oldDatabase).equals(before)).toBe(true)
    expect(readFileSync(join(base, 'old-note.txt'), 'utf8')).toBe('old data')
    expect(existsSync(paths.database)).toBe(true)
  })

  it('keeps the artifact and document folders beside the database, inside the root', () => {
    const paths = dataPaths(userData())
    const store = new HerStore(paths.database)
    try {
      expect(store.artifactDirectory).toBe(paths.artifacts)
      expect(store.documentDirectory).toBe(paths.documents)
    } finally { store.close() }
  })

  it('creates nothing outside the root', () => {
    const base = userData(), paths = dataPaths(base)
    new HerStore(paths.database).close()
    expect(readdirSync(base)).toEqual([DATA_ROOT_NAME])
  })
})

const { app } = require('electron')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')

app.whenReady().then(() => {
  app.dock?.hide()
  const root = process.argv[process.argv.indexOf('--nodejieba-root') + 1]
  const jieba = createRequire(resolve(root, 'package.json'))('nodejieba')
  const tokens = jieba.cutForSearch('燕麦拿铁和 TypeScript 训练平台', true)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE VIRTUAL TABLE smoke USING fts5(content)')
  db.prepare('INSERT INTO smoke(content) VALUES (?)').run(tokens.join(' '))
  const matches = db.prepare('SELECT count(*) AS count FROM smoke WHERE smoke MATCH ?').get('燕麦').count
  if (matches !== 1) throw new Error('Electron main-process FTS5 recall failed')
  console.log(JSON.stringify({ processType: process.type, electron: process.versions.electron,
    node: process.versions.node, sqlite: process.versions.sqlite, tokens, matches, passed: true }))
  db.close()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

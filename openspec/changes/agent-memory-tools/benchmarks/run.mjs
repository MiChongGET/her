import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const jiebaRoot = resolve(option('--nodejieba-root', '/tmp/her-memory-benchmark'))
const methods = ['like', 'intl-fts5', 'jieba-fts5', 'jieba-default-fts5']
const sha256 = data => createHash('sha256').update(data).digest('hex')
const splitTerms = text => [...new Set(text.split(/[\s,，]+/u).filter(Boolean))]
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]
const literalLike = text => '%' + text.replace(/[\\%_]/g, '\\$&') + '%'
const quotedFtsTerm = term => '"' + term.replaceAll('"', '""') + '"'

function tokenizer(method) {
  if (method === 'like') return splitTerms
  if (method === 'intl-fts5') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    return text => [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment)
  }
  const require = createRequire(resolve(jiebaRoot, 'package.json'))
  const jieba = require('nodejieba')
  jieba.load()
  // No user dictionary, stopword list, synonym expansion, or query-specific tuning.
  return text => jieba.cutForSearch(text, method === 'jieba-fts5').filter(term => /[\p{L}\p{N}]/u.test(term))
}

if (args.includes('--cold-probe')) {
  const method = option('--cold-probe')
  assert(methods.includes(method))
  const rssBefore = process.memoryUsage().rss
  const started = performance.now()
  const tokenize = tokenizer(method)
  const initialized = performance.now()
  const terms = tokenize('我喜欢燕麦拿铁，最近在处理 TypeScript 项目的流式响应。')
  console.log(JSON.stringify({ method, initializeMs: initialized - started,
    firstTokenizeMs: performance.now() - initialized,
    rssDeltaMiB: (process.memoryUsage().rss - rssBefore) / 1024 / 1024, terms }))
  process.exit(0)
}

const datasetBytes = readFileSync(resolve(here, 'dataset.json'))
const dataset = JSON.parse(datasetBytes)
const ids = new Set()
for (const memory of dataset.memories) {
  assert(Number.isSafeInteger(memory.id) && !ids.has(memory.id), 'unique integer memory id')
  ids.add(memory.id)
  assert(memory.content.trim() && [...memory.content].length <= 300)
  assert(Array.isArray(memory.keywords) && memory.keywords.length <= 5)
  assert(memory.keywords.every(word => typeof word === 'string' && word.trim()))
  assert(['preference', 'fact', 'event', 'agreement'].includes(memory.kind))
  assert(['active', 'superseded'].includes(memory.status))
}
const active = dataset.memories.filter(memory => memory.status === 'active')
const activeIds = new Set(active.map(memory => memory.id))
const queryIds = new Set()
for (const query of dataset.queries) {
  assert(!queryIds.has(query.id), 'unique query id')
  queryIds.add(query.id)
  assert(query.naturalQuery.trim() && query.keywordQuery.trim() && query.category && query.rationale)
  assert(Array.isArray(query.relevantIds) && new Set(query.relevantIds).size === query.relevantIds.length)
  assert(query.relevantIds.every(id => activeIds.has(id)), 'gold must refer to active records')
}

function buildRetriever(method, memories) {
  const db = new DatabaseSync(':memory:')
  const started = performance.now()
  const tokenize = tokenizer(method)
  const statements = new Map()
  if (method === 'like') {
    db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT, keywords TEXT)')
    const insert = db.prepare('INSERT INTO memories VALUES (?, ?, ?)')
    db.exec('BEGIN')
    for (const memory of memories) insert.run(memory.id, memory.content, memory.keywords.join(' '))
    db.exec('COMMIT')
  } else {
    db.exec('CREATE VIRTUAL TABLE memories USING fts5(content, keywords, tokenize="unicode61")')
    const insert = db.prepare('INSERT INTO memories(rowid, content, keywords) VALUES (?, ?, ?)')
    db.exec('BEGIN')
    for (const memory of memories) {
      insert.run(memory.id, tokenize(memory.content).join(' '), tokenize(memory.keywords.join(' ')).join(' '))
    }
    db.exec('COMMIT')
  }
  const buildMs = performance.now() - started
  const pages = db.prepare('PRAGMA page_count').get().page_count
  const pageSize = db.prepare('PRAGMA page_size').get().page_size
  const ftsSearch = method === 'like' ? null : db.prepare(
    'SELECT rowid AS id, bm25(memories, 1.0, 1.0) AS score FROM memories WHERE memories MATCH ? ORDER BY score ASC, rowid DESC LIMIT 10')
  function search(query) {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length) return { terms, matches: [] }
    if (method !== 'like') {
      return { terms, matches: ftsSearch.all(terms.map(quotedFtsTerm).join(' OR ')) }
    }
    let statement = statements.get(terms.length)
    if (!statement) {
      const predicate = "(content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')"
      const sum = terms.map(() => `CASE WHEN ${predicate} THEN 1 ELSE 0 END`).join(' + ')
      statement = db.prepare(`SELECT id, ${sum} AS score FROM memories WHERE ${terms.map(() => predicate).join(' OR ')} ORDER BY score DESC, id DESC LIMIT 10`)
      statements.set(terms.length, statement)
    }
    const patterns = terms.flatMap(term => [literalLike(term), literalLike(term)])
    return { terms, matches: statement.all(...patterns, ...patterns) }
  }
  return { search, buildMs, databaseBytes: pages * pageSize, close: () => db.close() }
}

// Small algorithm checks independent of the labelled benchmark; not quality tuning.
for (const method of methods) {
  const smoke = buildRetriever(method, [
    { id: 1, content: '用户喜欢咖啡。', keywords: ['饮品'] },
    { id: 2, content: '用户喜欢茶。', keywords: [] },
    { id: 3, content: '目标是 90%，变量 foo_bar，路径 C:\\notes。', keywords: [] }
  ])
  assert(smoke.search('咖啡').matches.some(row => row.id === 1))
  assert.deepEqual(smoke.search('不存在词汇XYZ123').matches, [])
  if (method === 'like') {
    for (const literal of ['%', '_', '\\']) assert.deepEqual(smoke.search(literal).matches.map(row => row.id), [3])
  }
  smoke.close()
}

function metrics(rows, k) {
  const positive = rows.filter(row => row.relevantIds.length)
  const negative = rows.filter(row => !row.relevantIds.length)
  let hit = 0, recall = 0, reciprocalRank = 0, relevantReturned = 0, totalReturned = 0
  for (const row of positive) {
    const retrieved = row.matches.slice(0, k).map(match => match.id)
    const matches = retrieved.filter(id => row.relevantIds.includes(id)).length
    const first = retrieved.findIndex(id => row.relevantIds.includes(id))
    hit += Number(matches > 0)
    recall += matches / row.relevantIds.length
    reciprocalRank += first < 0 ? 0 : 1 / (first + 1)
    relevantReturned += matches
    totalReturned += retrieved.length
  }
  return { positiveCount: positive.length, negativeCount: negative.length,
    hitCount: hit, hitRate: positive.length ? hit / positive.length : null,
    recall: positive.length ? recall / positive.length : null,
    mrr: positive.length ? reciprocalRank / positive.length : null,
    returnedPrecision: totalReturned ? relevantReturned / totalReturned : null,
    relevantReturned, totalReturned,
    noAnswerCandidateCount: negative.filter(row => row.matches.length).length,
    noAnswerCandidateRate: negative.length ? negative.filter(row => row.matches.length).length / negative.length : null }
}

const results = {
  generatedAt: new Date().toISOString(),
  label: option('--label', 'node'),
  datasetSha256: sha256(datasetBytes), runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  environment: { platform: process.platform, arch: process.arch, versions: process.versions, execPath: process.execPath },
  nodejiebaVersion: JSON.parse(readFileSync(resolve(jiebaRoot, 'node_modules/nodejieba/package.json'))).version,
  fixture: { totalMemories: dataset.memories.length, activeMemories: active.length,
    supersededMemories: dataset.memories.length - active.length, totalQueries: dataset.queries.length },
  configuration: { limit: 10, reportedK: [5, 10], ftsTokenizer: 'unicode61', ftsWeights: [1, 1],
    intlMode: 'Intl.Segmenter zh-CN word, isWordLike',
    jiebaMode: 'primary: cutForSearch(text,true), HMM enabled; sensitivity: cutForSearch(text,false), default HMM disabled; overlapping search terms in both',
    dictionary: 'nodejieba defaults; no custom words', queryOperator: 'OR',
    inputs: ['naturalQuery (stress test outside current tool contract)', 'keywordQuery (human proxy, not actual LLM output)'],
    activeOnlyIndex: true, synonyms: 'only the same fixture keywords shared by all methods',
    timing: 'warm in-memory SQLite; query tokenization + binding + retrieval; no model/network cost; 2 warmup passes and 8 timed passes per corpus',
    scale: 'active rows repeated verbatim with fresh ids; throughput only, not additional labelled quality data',
    databaseBytes: 'temporary benchmark database only; FTS stores pretokenized text, not the additional original memories table required in Her' },
  quality: {}, coldStart: {}, performance: {}
}

for (const method of methods) {
  const samples = []
  for (let repeat = 0; repeat < 3; repeat++) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--cold-probe', method, '--nodejieba-root', jiebaRoot],
      { encoding: 'utf8', env: process.env, timeout: 60_000 })
    assert.equal(child.status, 0, child.stderr)
    samples.push(JSON.parse(child.stdout.trim()))
  }
  results.coldStart[method] = { samples,
    medianInitializeMs: percentile(samples.map(sample => sample.initializeMs), 0.5),
    medianReadyMs: percentile(samples.map(sample => sample.initializeMs + sample.firstTokenizeMs), 0.5),
    medianRssDeltaMiB: percentile(samples.map(sample => sample.rssDeltaMiB), 0.5) }
  const retriever = buildRetriever(method, active)
  results.quality[method] = {}
  for (const input of ['keywordQuery', 'naturalQuery']) {
    const rows = dataset.queries.map(query => ({ queryId: query.id, category: query.category,
      query: query[input], relevantIds: query.relevantIds, ...retriever.search(query[input]) }))
    assert(rows.every(row => row.matches.every(match => activeIds.has(match.id))), 'superseded exclusion')
    results.quality[method][input] = {
      at5: metrics(rows, 5), at10: metrics(rows, 10),
      byCategory: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category =>
        [category, metrics(rows.filter(row => row.category === category), 5)])), rows }
  }
  retriever.close()
}

for (const size of [active.length, 1000, 10_000]) {
  const memories = Array.from({ length: size }, (_, index) => ({ ...active[index % active.length], id: index + 1 }))
  results.performance[size] = {}
  for (const method of methods) {
    const retriever = buildRetriever(method, memories)
    for (let pass = 0; pass < 2; pass++) for (const query of dataset.queries) retriever.search(query.keywordQuery)
    const durations = []
    for (let pass = 0; pass < 8; pass++) {
      for (let offset = 0; offset < dataset.queries.length; offset++) {
        const query = dataset.queries[(offset + pass * 17) % dataset.queries.length]
        const start = performance.now()
        retriever.search(query.keywordQuery)
        durations.push(performance.now() - start)
      }
    }
    results.performance[size][method] = { samples: durations.length, medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95), buildMs: retriever.buildMs, databaseBytes: retriever.databaseBytes }
    retriever.close()
  }
}

const output = resolve(option('--output', resolve(here, 'results-node.json')))
writeFileSync(output, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ output, fixture: results.fixture, datasetSha256: results.datasetSha256,
  versions: results.environment.versions,
  keyword: Object.fromEntries(methods.map(method => [method, results.quality[method].keywordQuery.at5])),
  natural: Object.fromEntries(methods.map(method => [method, results.quality[method].naturalQuery.at5])),
  coldStart: Object.fromEntries(methods.map(method => [method, {
    readyMs: results.coldStart[method].medianReadyMs, rssDeltaMiB: results.coldStart[method].medianRssDeltaMiB }])),
  performance: results.performance }, null, 2))

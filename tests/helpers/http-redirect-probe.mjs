import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const root = process.argv[2]
const http = await import(pathToFileURL(join(root, 'build/utils/httpRequest.js')).href)
const fetcher = await import(pathToFileURL(join(root, 'build/engines/web/fetchWebContent.js')).href)
const bing = await import(pathToFileURL(join(root, 'build/engines/bing/bing.js')).href)
const urls = [], searchUrls = []
http.__setAxiosRequestForTests(async options => {
  urls.push({ method: options.method, url: options.url })
  return { status: 302, headers: { location: 'https://www.raffles.com/london/' }, request: { res: {} } }
})
await assert.rejects(fetcher.fetchWebContent('https://www.raffles.com/singapore/', 1000, { renderMode: 'request', redirectPolicy: 'error' }), /Too many redirects \(max 0\)/)
assert.deepEqual(urls, [{ method: 'HEAD', url: 'https://www.raffles.com/singapore/' }, { method: 'GET', url: 'https://www.raffles.com/singapore/' }])
bing.__setBingHttpGetForTests(async url => {
  searchUrls.push(url)
  return { status: 302, headers: { location: 'https://www.bing.com/search?q=outside' } }
})
await assert.rejects(bing.searchBing('fictional hotel comparison', 1, { searchMode: 'request' }), /regional redirect limit \(0\)/)
assert.equal(searchUrls.length, 1)
assert.equal(new URL(searchUrls[0]).origin, 'https://cn.bing.com')
console.log(JSON.stringify({ fetchDispatches: urls, searchDispatches: searchUrls, forbiddenRedirectDispatches: 0, evidence: 'installed request implementation with injected HTTP response boundary; not live endpoint traffic' }))

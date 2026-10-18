import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dependencySetup } from '../src/core/mcp/dependency-setup'
import type { DependencyCheck } from '../src/shared/types'

const check = (component: string, status: DependencyCheck['status'] = 'missing'): DependencyCheck => ({ component, status, message: 'diagnostic' })
describe('fixed dependency installation guidance', () => {
  it('only supplies actions for known non-ready components', () => {
    expect(dependencySetup('peekaboo', check('Peekaboo', 'ready'))).toBeUndefined()
    expect(dependencySetup('unknown', check('Peekaboo'))).toBeUndefined()
    expect(dependencySetup('peekaboo', check('arbitrary'))).toBeUndefined()
    expect(dependencySetup('peekaboo', check('Chrome'))).toBeUndefined()
  })
  it('uses fixed native version and checksum, official Node and Chrome pages', () => {
    const native = dependencySetup('peekaboo', check('Peekaboo', 'incompatible'))!
    expect(native.steps.join(' ')).toContain('4.9.3')
    expect(native.steps.join(' ')).toContain('ce0f4f9824c64092c03cac759fdd58e174e19f7770f170c9f59bf009410d7d26')
    expect(native.links[0].url).toContain('4.9.3')
    expect(dependencySetup('playwright', check('Node.js'))!.links[0].url).toBe('https://nodejs.org/en/download')
    expect(dependencySetup('open-websearch', check('npm'))!.steps.join(' ')).toContain('20.18.1')
    expect(dependencySetup('playwright', check('Chrome'))!.links[0].url).toBe('https://www.google.com/chrome/')
  })
  it('distinguishes macOS permissions and browser extension authorization from reinstalling tools', () => {
    const permission = dependencySetup('peekaboo', check('Accessibility', 'permission_required'))!
    expect(permission.command).toBeUndefined()
    expect(permission.links).toEqual([])
    expect(permission.steps.join(' ')).toContain('辅助功能')
    expect(permission.steps.join(' ')).toContain('Electron')
    const extension = dependencySetup('playwright', check('Playwright 扩展', 'permission_required'))!
    expect(extension.links[0].url).toContain('mmlmfjhmonkocbjadbfplnigmagldckm')
    expect(extension.steps.join(' ')).toContain('授权')
    expect(extension.command).toBeUndefined()
  })
  it('uses actual resources for the pinned document installer and npm lock', () => {
    const root = '/Applications/Her.app/Contents/Resources'
    expect(dependencySetup('markitdown', check('MarkItDown'), root)!.command).toBe(`sh '${root}/dependencies/markitdown/install.sh'`)
    expect(dependencySetup('markitdown', check('MarkItDown'), root)!.links[0].url).toContain('docs.astral.sh/uv')
    for (const [preset, component] of [['playwright', '@playwright/mcp'], ['playwright', 'playwright-core'], ['playwright', 'playwright'], ['open-websearch', 'open-websearch']]) {
      const setup = dependencySetup(preset, check(component), root)!
      expect(setup.command).toContain(`'${root}/mcp-web-dependencies/package-lock.json'`)
      expect(setup.command).toContain('npm ci --ignore-scripts')
      expect(setup.command).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1')
    }
    expect(dependencySetup('markitdown', check('MarkItDown'))!.command).toBeUndefined()
  })
  it('quotes resource paths without expanding shell expressions or single quotes', () => {
    const root = "/tmp/Her's resources $(exit 97)"
    const document = dependencySetup('markitdown', check('MarkItDown'), root)!.command!
    const result = execFileSync('/bin/sh', ['-c', `sh() { printf '%s' "$1"; }; ${document}`], { encoding: 'utf8' })
    expect(result).toBe(`${root}/dependencies/markitdown/install.sh`)
    const web = dependencySetup('playwright', check('@playwright/mcp'), root)!.command!
    const copied = execFileSync('/bin/sh', ['-c', `mkdir() { :; }; cp() { printf '%s\\n' "$1" "$2"; }; cd() { :; }; npm() { :; }; ${web}`], { encoding: 'utf8' })
    expect(copied.split('\n').slice(0, 2)).toEqual([`${root}/mcp-web-dependencies/package.json`, `${root}/mcp-web-dependencies/package-lock.json`])
  })
})

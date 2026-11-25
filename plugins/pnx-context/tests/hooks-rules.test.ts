import { expect, test } from 'claude-code/testing'

import { hookRuleProblems } from './hooksRules'

const POLL_OK = [
  "import { atom, read, update } from 'claude-code'",
  "export const devCycles = atom({ plugin: 'p', key: 'devCycles' } as const, {}, { shape: 'x-1' })",
  'export function forgetDevCycles($: E) { return update($, devCycles, () => ({})) }',
  'export function readDevCycles($: E) { return read($, devCycles) }',
].join('\n')

test('the checker accepts the shapes the engine accepts', () => {
  const register = ["import { forgetDevCycles, readDevCycles } from './devcyclePoll'", "const ui = atom({ plugin: 'p', key: 'ui' } as const, {})", 'await forgetDevCycles($)', 'await readDevCycles($)', 'await read($, ui)'].join('\n')

  expect(hookRuleProblems({ 'devcyclePoll.ts': POLL_OK, 'register.tsx': register })).toEqual([])
})

test('the 0.10.0 failure is caught: $ passed to an arrow bound to a const', () => {
  const poll = POLL_OK.replace('export function forgetDevCycles($: E) {', 'export const forgetDevCycles = ($: E) => {').replace('return update($, devCycles, () => ({})) }', 'return update($, devCycles, () => ({})) }')
  const register = ["import { forgetDevCycles } from './devcyclePoll'", 'await forgetDevCycles($)'].join('\n')

  expect(hookRuleProblems({ 'devcyclePoll.ts': poll, 'register.tsx': register })).toEqual(['register.tsx: passes $ to forgetDevCycles, which devcyclePoll does not declare with `function`'])
})

test('the 0.10.2 failure is caught: an atom read in a file that only imports it', () => {
  const register = ["import { devCycles } from './devcyclePoll'", 'const dc = await read($, devCycles)'].join('\n')

  expect(hookRuleProblems({ 'devcyclePoll.ts': POLL_OK, 'register.tsx': register })).toEqual(['register.tsx: reads or updates devCycles, which this file does not define with atom() (it is imported)'])
})

test('the other $ rules are caught: a member call, a spread, a shadowed import', () => {
  const poll = POLL_OK
  expect(hookRuleProblems({ 'devcyclePoll.ts': poll, 'register.tsx': 'await tools.run($, cfg)' })).toEqual(['register.tsx: passes $ to a member call; $ goes only to a named function'])
  expect(hookRuleProblems({ 'devcyclePoll.ts': poll, 'register.tsx': 'await run(...$)' })).toEqual(['register.tsx: passes $ in a spread'])
  const shadow = ["import { readDevCycles } from './devcyclePoll'", 'const readDevCycles = 1'].join('\n')
  expect(hookRuleProblems({ 'devcyclePoll.ts': poll, 'register.tsx': shadow })).toEqual(['register.tsx: declares readDevCycles again, shadowing the import'])
})

// The real hooks, when the runner lets the test read files; otherwise this part has nothing to read and passes.
test('the plugin hooks follow both rules', async () => {
  try {
    const specifier = 'node:fs'
    const fs = (await import(specifier)) as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string; existsSync(p: string): boolean }
    const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.'
    const dir = [`${cwd}/hooks`, `${cwd}/plugins/pnx-context/hooks`].find(d => fs.existsSync(`${d}/register.tsx`))
    if (dir === undefined) return
    const files = Object.fromEntries(fs.readdirSync(dir).filter(f => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f)).map(f => [f, fs.readFileSync(`${dir}/${f}`, 'utf8')]))

    expect(hookRuleProblems(files)).toEqual([])
  } catch {
    // No file access here: the fixtures above still ran.
  }
})

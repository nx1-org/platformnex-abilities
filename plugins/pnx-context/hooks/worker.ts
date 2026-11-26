/**
 * The PlatformNEX worker (`pnx claude run`) this plugin runs while Claude Code is open, with the plugin's own key and
 * address, so the development cycles a person starts use their own Claude Code. Pure parts only: the engine side is in
 * register.tsx. It runs quietly: the pane shows one Dev cycles line, and what it does goes to the debug log. pnx itself
 * is installed and kept current by the pnx-fast-dev Ability.
 */

import type { ClaudeCode } from '../types'
import type { CheckStep } from './api'

/** The first pnx with `--auto-link` and one worker per machine. */
export const MIN_PNX = '0.1.18'
/** The first pnx with `pnx activity`, which the Dev cycles view reads. */
export const MIN_ACTIVITY_PNX = '0.1.19'
/** pnx's exit code when another worker already runs on this machine. */
export const ALREADY_RUNNING_EXIT = 3
/** How long to wait before trying again after the worker stopped or another window holds it. */
export const RETRY_MS = 60_000
/** How long to wait before looking for pnx again when it is missing or too old. */
export const MISSING_RETRY_MS = 10 * 60_000

/** pnx talks to catalog-gateway, which the portal serves under /api/catalog. */
export const catalogUrlOf = (base: string): string => `${base}/api/catalog`

/**
 * Run with `node -e`: prints where the global pnx is and its version, as JSON. Node starts npm's own command through a
 * shell, so this works on Windows (npm.cmd) as on macOS and Linux, and pnx is then started as `node <cli.js>`, never
 * through a .cmd shim, so stopping it stops the worker itself.
 */
export const FIND_PNX = [
  "const cp=require('child_process'),p=require('path'),f=require('fs');",
  "let r='';try{r=cp.execSync('npm root -g',{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{}",
  "const d=p.join(r,'@platformnex','pnx');let v='';",
  "try{v=JSON.parse(f.readFileSync(p.join(d,'package.json'),'utf8')).version||''}catch{}",
  "process.stdout.write(JSON.stringify({cli:v?p.join(d,'dist','cli.js'):'',version:v}))",
].join('')

/** What FIND_PNX printed: the cli path and version, or nothing when pnx isn't installed. */
export function parseFind(stdout: string): { cli?: string; version?: string } {
  try {
    const o = JSON.parse(stdout) as { cli?: unknown; version?: unknown }
    const cli = typeof o.cli === 'string' && o.cli !== '' ? o.cli : undefined
    const version = typeof o.version === 'string' && o.version !== '' ? o.version : undefined

    return { cli, version }
  } catch {
    return {}
  }
}

/** True when `version` (x.y.z) is at least `min`. Anything unparseable is not. */
export function isAtLeast(version: string | undefined, min: string = MIN_PNX): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4).map(Number)
  const v = version === undefined ? undefined : parse(version)
  const m = parse(min)
  if (v === undefined || m === undefined) return false
  for (let i = 0; i < 3; i++) if (v[i] !== m[i]) return (v[i] ?? 0) > (m[i] ?? 0)

  return true
}

/** The last line of a piece of pnx output, without its timestamp or `pnx:` prefix, short. */
export function lineNote(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '')
    .pop()
  if (line === undefined) return undefined
  const clean = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '').replace(/^pnx:\s*/, '')

  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean
}

/** Whether a piece of pnx output says the worker is now taking jobs. */
export const isTakingJobs = (text: string): boolean => text.includes('Taking PlatformNEX jobs')

/** pnx's own folder, as pnx finds it (`d`), for the `node -e` scripts below; needs `p` (path) and `o` (os). */
const PNX_DIR = "const e=process.env,d=e.PNX_CONFIG_DIR||p.join(e.XDG_CONFIG_HOME||p.join(o.homedir(),'.config'),'pnx');"

/** Run with `node -e`: prints the machine link pnx saved (`claude-device.json`: no secret, only ids), or nothing. */
export const FIND_DEVICE = [
  "const p=require('path'),f=require('fs'),o=require('os');",
  PNX_DIR,
  "try{process.stdout.write(f.readFileSync(p.join(d,'claude-device.json'),'utf8'))}catch{}",
].join('')

/** The device id from FIND_DEVICE's output, only when it was linked to this PlatformNEX (`catalogUrl`). */
export function parseDeviceId(stdout: string, catalogUrl: string): string | undefined {
  try {
    const o = JSON.parse(stdout) as { deviceId?: unknown; catalogUrl?: unknown }

    return typeof o.deviceId === 'string' && o.deviceId !== '' && o.catalogUrl === catalogUrl ? o.deviceId : undefined
  } catch {
    return undefined
  }
}

/**
 * Run with `node -e`: prints, as JSON, what the worker needs besides pnx: Node's version, git, gh and its sign-in, and
 * what the pnx-fast-dev Ability left in pnx's folder (that it ran, and why its last install failed, if it did).
 */
export const FIND_NEEDS = [
  "const cp=require('child_process'),p=require('path'),f=require('fs'),o=require('os');",
  "const ok=c=>{try{cp.execSync(c,{stdio:'ignore',timeout:10000});return true}catch{return false}};",
  PNX_DIR,
  "const read=n=>{try{return f.readFileSync(p.join(d,n),'utf8').trim()}catch{return ''}};",
  "const gh=ok('gh --version');",
  "process.stdout.write(JSON.stringify({node:process.versions.node,git:ok('git --version'),gh,ghSignedIn:gh&&ok('gh auth status'),fastDevRan:f.existsSync(p.join(d,'.ensure-checked')),problem:read('.ensure-problem'),released:read('.ensure-latest')}))",
].join('')

/**
 * Run with `node -e`: tells pnx-fast-dev the pnx dev cycles need (`.ensure-wanted`). Until it has it, pnx-fast-dev
 * checks at every Claude Code start instead of once a day, so an update or a release arrives at the next start.
 */
export const wantPnx = (version: string): string =>
  [
    "const p=require('path'),f=require('fs'),o=require('os');",
    PNX_DIR,
    `try{f.mkdirSync(d,{recursive:true});f.writeFileSync(p.join(d,'.ensure-wanted'),'${version}')}catch{}`,
  ].join('')

export const WANT_PNX = wantPnx(MIN_PNX)
/** The same for a pnx that has `pnx activity`: asked once when the view finds pnx missing or older. */
export const WANT_ACTIVITY_PNX = wantPnx(MIN_ACTIVITY_PNX)

/** `released`: the newest pnx the registry had at pnx-fast-dev's last try, '' when unknown. */
export type Needs = { node: string; git: boolean; gh: boolean; ghSignedIn: boolean; fastDevRan: boolean; problem: string; released: string }

/** What FIND_NEEDS printed, or undefined when it did not run (no Node). */
export function parseNeeds(stdout: string | undefined): Needs | undefined {
  try {
    const o = JSON.parse(stdout ?? '') as Record<string, unknown>
    if (typeof o['node'] !== 'string') return undefined

    const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')

    return { node: o['node'], git: o['git'] === true, gh: o['gh'] === true, ghSignedIn: o['ghSignedIn'] === true, fastDevRan: o['fastDevRan'] === true, problem: text('problem'), released: text('released') }
  } catch {
    return undefined
  }
}

const NODE_FIX = 'install Node.js 20 or newer from nodejs.org, then press k'

const SIGN_IN = 'gcloud auth login, then gcloud auth application-default login'

/** How to get pnx when it is missing or too old, from what pnx-fast-dev said about its last try. */
function pnxFix(needs: Needs, isMissing: boolean): string {
  // The registry's newest is older than dev cycles need: no install or sign-in helps until it is released.
  if (needs.released !== '' && !isAtLeast(needs.released)) return `pnx ${MIN_PNX} isn't released yet; it installs by itself once it is`
  if (needs.problem === 'auth') return `sign in to Google: ${SIGN_IN}, then restart Claude Code`
  if (needs.problem === 'access') return `sign in with your work Google account (${SIGN_IN}) and restart Claude Code. Still failing? Ask a PlatformNEX admin`
  if (needs.problem === 'network') return "can't download pnx: check your internet or VPN, then restart Claude Code"
  if (needs.problem === 'install') return "pnx didn't install (details in ~/.config/pnx/install.log): restart Claude Code to try again"
  if (!needs.fastDevRan) return 'add the pnx-fast-dev plugin (it installs pnx), then restart Claude Code'

  // pnx-fast-dev installs or updates it at the next start (WANT_PNX lifts its once-a-day wait).
  return isMissing ? 'it installs by itself: restart Claude Code in a few minutes' : 'it updates by itself: restart Claude Code'
}

/**
 * The check's Dev cycles lines: one line when the worker is online or turned off, otherwise each thing it needs with
 * what to do about the missing ones, and why the last try stopped.
 */
export function devCycleSteps(w: { isOff: boolean; status: ClaudeCode['status']; note?: string; needs?: Needs; pnx: { cli?: string; version?: string } }): CheckStep[] {
  if (w.isOff) return [{ label: 'Dev cycles', ok: undefined, detail: 'turned off in settings' }]
  if (w.status === 'online') return [{ label: 'Dev cycles', ok: true, detail: 'your Claude Code is online' }]
  const needs = w.needs
  if (needs === undefined) return [{ label: 'Node.js', ok: false, detail: 'not found', fix: NODE_FIX }]
  const major = Number(needs.node.split('.')[0])
  const steps: CheckStep[] = [
    major >= 20 ? { label: 'Node.js', ok: true, detail: needs.node } : { label: 'Node.js', ok: false, detail: `${needs.node} is too old`, fix: NODE_FIX },
    w.pnx.cli === undefined
      ? { label: 'pnx', ok: false, detail: 'not installed', fix: pnxFix(needs, true) }
      : isAtLeast(w.pnx.version)
        ? { label: 'pnx', ok: true, detail: w.pnx.version ?? '' }
        : { label: 'pnx', ok: false, detail: `${w.pnx.version ?? '?'} is too old (needs ${MIN_PNX})`, fix: pnxFix(needs, false) },
    needs.git ? { label: 'git', ok: true, detail: 'installed' } : { label: 'git', ok: false, detail: 'not found', fix: 'install git from git-scm.com' },
    !needs.gh
      ? { label: 'gh', ok: false, detail: 'not installed (needed for pull requests)', fix: 'install the GitHub CLI from cli.github.com, then run: gh auth login' }
      : needs.ghSignedIn
        ? { label: 'gh', ok: true, detail: 'signed in' }
        : { label: 'gh', ok: false, detail: 'not signed in (needed for pull requests)', fix: 'run: gh auth login' },
  ]
  // Why the last try stopped, unless a Node.js or pnx failure above already says it (git and gh never stop the worker).
  const isExplained = steps.some(s => (s.label === 'Node.js' || s.label === 'pnx') && s.ok === false)
  if (w.note !== undefined && !isExplained) steps.push({ label: 'last try', ok: undefined, detail: w.note })

  return steps
}

/**
 * What a session ending means for the worker. `/clear` and `/resume` keep Claude Code running, so it goes on (keep);
 * `/exit`, Ctrl+C or a signal end Claude Code, so it stops (leave); anything else (a logout, a reason a later Claude Code
 * adds) stops it and lets it start again if Claude Code goes on (pause).
 */
export function sessionEndAction(reason: string): 'keep' | 'leave' | 'pause' {
  if (reason === 'clear' || reason === 'resume') return 'keep'

  return reason === 'prompt_input_exit' || reason === 'other' ? 'leave' : 'pause'
}

/** Why the worker stopped, for the debug log: another window runs it, or its last error line. */
export function endedNote(code: number | null, lastError: string | undefined): string {
  if (code === ALREADY_RUNNING_EXIT) return 'another Claude Code window on this machine runs it'

  return `stopped (${lastError ?? `exit ${code ?? 'signal'}`}); trying again in a minute`
}

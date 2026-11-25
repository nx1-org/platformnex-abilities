export type Environment = { id: number; name: string; isProduction: boolean }

export type Health = {
  status: string
  computedAt?: string
  /** Up to three short reasons, already length-capped. */
  reasons: string[]
  /** One status word per day, oldest first. */
  history: string[]
}

export type Release = { id: string; status: string; environment?: string; target?: string }

export type Match = {
  entityRef: string
  name: string
  title?: string
  systemRefs: string[]
  environments: Environment[]
  health?: Health
  /** Latest builds' outcomes, oldest first: ok | bad | other. */
  builds?: string[]
  /** Request counts over the metrics window, oldest first. */
  requests?: number[]
  releases?: Release[]
  /** When this match's detail was read, ms since the epoch. */
  detailAt?: number
  /** Why some detail is missing, short. */
  detailNote?: string
}

export type RepoView = {
  root: string
  /** The folder's own name. */
  name: string
  /** Remote with any login removed. */
  remote?: string
  branch?: string
  head?: string
  lookup: 'found' | 'none' | 'error'
  matches: Match[]
}

export type Data = {
  at: number
  status: 'unconfigured' | 'ok' | 'error'
  /** Short and free of URLs, keys and response text. */
  error?: string
  repos: RepoView[]
}

/** One answer from a PlatformNEX tool, cut down to what the pane draws. Never holds a key, token or the raw response. */
export type Ask = {
  id: string
  /** The tool's own name: plan_propose. */
  tool: string
  at: number
  /** A change plan, or why asking for one failed. */
  kind: 'plan' | 'error'
  title: string
  /** The System the question was about, without the system: prefix. */
  system?: string
  /** What was asked, for a plan. */
  asked?: string
  /** Plan only. */
  risk?: string
  executed?: boolean
  steps?: { label: string; detail: string }[]
  evidence?: { k: string; v: string }[]
  note?: string
}

export type Asks = { items: Ask[] }

/** One step of a Check: ok is undefined for one skipped or only informative. */
export type CheckLine = { label: string; ok?: boolean; detail: string; fix?: string }

/** A Check's steps for one thing: the key, the lookup route or dev cycles. */
export type CheckGroup = { name: string; steps: CheckLine[] }

/**
 * A sign-in in progress or failed, as the pane draws it. Only what the person sees: the link, the short code they check
 * in the portal, the time it runs out and a fixed message. Never a token, the device code or text pnx printed.
 */
export type SigninView = {
  phase: 'starting' | 'waiting' | 'failed'
  userCode?: string
  link?: string
  /** When the code runs out, ms since the epoch. */
  expiresAt?: number
  /** Redraw marker for the countdown. */
  at?: number
  message?: string
}

export type Ui = {
  /** The repository the person chose; empty means follow the session. */
  chosenRoot?: string
  /** The repository the session's own tool calls touched last. */
  touchedRoot?: string
  /** The id of the answer the person dismissed with x. */
  askHidden?: string
  /** True while the ASK answer is shown in full (m). */
  askOpen?: boolean
  /** Which page of the repository list is showing, from 0. */
  page?: number
  /** The component tab the person picked, by entity ref; empty means the first. */
  activeEntity?: string
  /** A release draft waiting for the person's confirmation. */
  pending?: { entityRef: string; environmentId: number; environmentName: string; branch: string; head?: string }
  /** The result of the last action, one line plus an optional link. */
  notice?: { text: string; url?: string }
  /** Setup in the pane: the environment picked (prod, dit1), whether a key is being checked, and the last result. Never the key. */
  setupEnv?: 'prod' | 'dit1'
  setupBusy?: boolean
  setupNote?: { text: string; tone: 'error' | 'info' }
  /** The steps of connecting that went well (key accepted, saved, connected), shown with a ✓. */
  setupDone?: string[]
  /**
   * The last Check, until dismissed: its steps in groups (key, lookup, dev cycles), never the key. isChecking while it
   * runs, note when it could not run.
   */
  check?: { groups: CheckGroup[]; isReady: boolean; isChecking?: boolean; note?: string }
  /** The sign-in in progress, or why the last one failed. */
  signin?: SigninView
  /** Who is signed in through the sign-in option (from pnx's own answer); none for a key, or after a restart. */
  signinEmail?: string
  /** True while the CONNECTION panel is open (s): switch environment or key, or disconnect. */
  connOpen?: boolean
  /** True while Disconnect waits for the person's yes. */
  confirmDisconnect?: boolean
  /** True while the pane reads everything again (⟳, a new connection, the timer), or a ⟳ waits for one to finish. */
  isRefreshing?: boolean
}

/** Whether this machine's Claude Code takes PlatformNEX's dev-cycle jobs now (the worker the plugin runs), and why the last try stopped. */
export type ClaudeCode = { status: 'connecting' | 'online' | 'offline'; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'pnx-context': { data: Shaped<Data>; ui: Shaped<Ui>; asks: Shaped<Asks>; claudeCode: Shaped<ClaudeCode> }
  }
}

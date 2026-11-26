# pnx-context

A Claude Code mod that shows, beside your conversation, which PlatformNEX component the repo you are in belongs to, in four short views. It can also open a **draft** release for a non-production environment. It never deploys.

## The four views

The header names the component and its health. Under it, `1` to `4` pick a view (`5` opens Dev cycles, below); the pane opens on **Live** while a deploy runs and on **Next** otherwise.

| View | Shows |
| --- | --- |
| `1` Live | The deploy under way (or the one that ended in the last 30 minutes) as steps: approval while it waits for one, tag pushed, build, rollout when the release holds a canary, deployed. Steps only: logs are a link to the portal. While a deploy runs its release is read again every 15 seconds. |
| `2` Next | Up to three things that need you, most urgent first: a build that did not start, a release that failed, a release ready to deploy, then the System's health reasons. Each has one action: a link to the release, or a button that puts the report into this chat as a prompt (**fix with Claude**, **bring into chat**). |
| `3` Release | The open release: how many phases are reviewed, the phase it stopped at (to review, not ready yet, or stale with the reason) and the phases left. The draft buttons are here. |
| `4` Environments | One row for each environment: what last deployed there, when, and any release open for it; plus your local branch and commit. |

A line above the prompt says the same in short while a deploy runs or something needs you, whether the pane is open or not.

The buttons that put text into the chat send nothing to PlatformNEX. Text that came from PlatformNEX is quoted in that prompt as data.

## Set up (once per person)

Connect in one of two ways. Both act as you, so keep the connection private.

**Sign in** (the default): pick the environment, then press **Sign in** in the pane. pnx opens the portal in your browser (the code is already filled in): sign in there if asked, check that the code matches the one in the pane, and press **Approve**. If the page does not open, the pane has a link (**copy link** helps). The pane then says `connected as <your email> via sign-in`. **Cancel** ends it at any time. The code runs out after 10 minutes (the pane counts down).

- **Needs pnx 0.1.20 or newer** (the pnx-fast-dev Ability installs and updates it), and the server must have sign-in turned on. If either is missing the pane says so and leaves the API key option below it; it never switches by itself.
- **The plugin never holds your password, an API key or a long-lived token.** pnx does the sign-in and keeps what it needs in your operating system's credential store (it refuses to sign in if there is none). The plugin only asks pnx for a short-lived access token (`pnx token`), keeps it in memory and asks again a minute before it ends. Nothing about the sign-in is written to the pane's saved state, a file or a log.
- **A session is limited.** A token lasts 10 minutes and a session at most 12 hours; it ends sooner when you sign out of the portal, end it in Account, Sessions, or leave it idle for 2 hours. The pane then goes back to setup and says "Your sign-in ended. Sign in again." Across Claude Code restarts the pane connects again by itself (without showing your email), unless an API key is saved: that is used first.
- **Dev cycles use the same sign-in.** pnx runs without `PNX_API_KEY` and reads the session itself. An API key in pnx's own config or environment still wins over it.

**With an API key** (the other way): you need a personal API key. It acts as you, so keep it private.

**In the pane** (the usual way for a key, on any OS): pick the environment (Production or dit1), open **API keys** from the link, create a key, then paste it into the pane's field and press **connect** (it shows **checking…** meanwhile). The pane checks the key with that PlatformNEX and saves it for this plugin only (never in the chat), ticking each step under the field (✓ key accepted, ✓ saved, ✓ connected; a ✗ with the reason if one fails). It then switches to the component view, which always says which PlatformNEX it is connected to (`✓ PlatformNEX   connected to Production`, with `● Dev cycles` under it), and runs the check, whose result stays in the pane (closing and reopening it keeps it) until `q` closes it. No restart is needed: Claude can use the plan tool from the next prompt. **✓** (check, `k`) at the top right runs it again at any time. If that PlatformNEX later refuses the key (revoked or expired), or the saved key is not a `pnx_` key, the pane goes back to setup and says why.

**⟳** (refresh, `r`) is a fresh connection: it signs in again with the key and reads everything again, and if dev cycles are not running it starts them now, looking up Node.js, gh and pnx afresh (no wait for the next retry). Dev cycles that are already running are left alone, as a job may be under way. A program installed while Claude Code is open is found only if it went into a folder already on PATH; if its installer changed PATH, restart Claude Code (on Windows, close VS Code fully) first.

**Change or disconnect** later with **⚙** (change, `s`) at the top right. It opens a CONNECTION panel: pick another environment or paste another key and press **connect** to switch (dev cycles restart on the new one, with no restart of Claude Code; if the new key is refused you stay on the old one), or **⏻ disconnect**, which asks first, then stops dev cycles, tells PlatformNEX this machine is offline, stops using the key and goes back to setup. After a sign-in, Disconnect also runs `pnx logout`: pnx ends the session on the server and deletes what it saved on this machine (if pnx can't, the pane says so; run `pnx logout` yourself). Press **Sign in** in the same panel to switch to a sign-in. `q` closes the panel and changes nothing.

**From a terminal** instead:

1. **Create the key** in the PlatformNEX portal: user menu, **API keys**. It starts with `pnx_`. Do not paste it into chat, an editor or a file.
2. **Save it.** In Claude Code run `/pnx-context setup`; it prints the exact command to copy. In your own terminal that is:

   ```bash
   read -rs K && printf '{"apiKey":"%s"}' "$K" | claude plugin configure pnx-context@platformnex-abilities --values-stdin; unset K
   ```

   `read -rs` waits for you to paste the key without showing it, so it stays out of your shell history. Or, inside Claude Code: `/plugin configure pnx-context@platformnex-abilities`.

   Running `claude plugin configure pnx-context@platformnex-abilities` on its own only **lists** the options; it does not set them.
3. **Restart Claude Code**, then run `/pnx-context check`.

The portal address has a default, so only the key is needed. To use another environment, add `"baseUrl": "https://..."` to the same JSON (https only, no path).

## Dev cycles on your Claude Code

Once the key is saved, the pane also keeps this machine's Claude Code connected to PlatformNEX whenever Claude Code is open (it runs `pnx claude run --allow-codegen --auto-link` in the background). That is what lets the development cycles you start use your own Claude Code: drafting the plan, Start coding, Continue and Run again. There is nothing else to run: it links this machine the first time, uses the key and address saved here (not the ones in pnx's own `~/.config/pnx/config.json`; pnx keeps its machine link and its one-per-machine lock in that folder), and stops when you leave Claude Code, telling PlatformNEX at once.

- **It needs** Node.js 20 or newer, Claude Code signed in, `git` and `gh` signed in for coding jobs, and pnx 0.1.18 or newer, which the pnx-fast-dev Ability installs and keeps current.
- **The pane says nothing while it is online.** When it is not, one line says `○ Dev cycles offline · press k to see why`.
- **When it is offline, ✓ check (`k`) shows why**: which of those is missing (for pnx, also why pnx-fast-dev could not install it) and the last error, each ✗ with what to do. It also tries to connect again at once, so after installing what was missing there is no wait. More detail goes to the debug log (`claude --debug`).
- **One per machine.** A second Claude Code window shows it online too; if the window running it closes, another open one takes over within a minute.
- **To turn it off**, set the `devCycles` option to `off` (`/plugin configure pnx-context@platformnex-abilities`): the pane only.

A coding job may push a `platformnex/` branch and open a draft pull request with your own git and gh sign-ins; it never merges and never deploys.

## Dev cycles view

A fifth view, `5` Dev cycles, shows only dev cycles, because they are not about the open repository: nothing about repositories, health, releases or deploy steps is there. It is never picked by itself. Its label carries a badge so it is noticed from the other views: `◐N` while N jobs run, `✕` for a failure you have not seen yet (it clears once you have opened the view and left it), nothing when idle. On a narrow pane the label shortens to `Dev`. It is offered even where no component is found; the other four are not.

It shows up to five jobs, then `+N more`, two short lines each: `◐ title   writing 4 files`, then `repo · this machine | cloud · 3m`. Marks (always with a word): ◐ running, ✓ done (with `PR #n`), ✕ failed (with a short fixed reason) or interrupted, ⏸ starting or queued, ⊘ cancelled. Under the rows is the log, the last 12 events as `HH:MM  text`; `l` shows the last 30 and back. A failed job and its log lines are red, and also say so in words. With nothing to show it says "No dev cycle running. Start one in PlatformNEX." When a job seen running on this machine finishes or fails, one line appears in the notice area (in this view under the log).

- **This machine** comes from `pnx activity --json`, which reads a small file the pnx worker keeps. It needs no key and makes no network call. It is read every 3 s while a job runs or the view is open, else every 15 s. It needs **pnx 0.1.19 or newer**. The log has phase lines (cloning, writing files, committing N files, opening the draft pull request, finished or failed with a short reason) only while a job runs, and, once at the commit step, one `changed <path>` line per file (first 10); there is no per-file line while Claude is still working. If the file can't be read the view says "Log unavailable on this machine" and never pnx's own text. With an older pnx (or none) it shows only the cloud rows and one line, "Update pnx for the live log on this machine", and asks pnx-fast-dev for the newer pnx.
- **Cloud** comes from the server's live coding-agent runs for the Systems you can read (`GET /api/catalog/catalog/dev-cycles/codegen/live`, with your key's token), every 15 s while one is live, else every 60 s. These runs name a component, not a repository or branch, so a run the cloud and this machine both report can show twice.
- **Never shown**: a key, token, address, the pull request's address (only its number), pnx's own error text, or anything outside the named fields. Everything from pnx and the server is cut to a short length, stripped of control characters, and dropped if it looks like a secret.

## Commands

| Command | Does |
| --- | --- |
| `/pnx-context` | open the pane |
| `/pnx-context refresh` | open it and read everything again now |
| `/pnx-context setup` | print the commands to save your key |
| `/pnx-context check` | test the address, the key and the lookup route, and say what to fix. It never shows the key |

In the pane (when it has focus): `1` to `5` switch views, `t` moves to the repository's next component, `w` opens the repository list (`a` to `h` pick one, `p` and `n` turn its page), `r` refreshes, `k` runs the check and shows its result in the pane (`q` closes it), `x` dismisses a plan, `m` shows it in full or short. In the Next view `a`, `b`, `c` run an item's action; in the Dev cycles view `l` shows the full log or the short one.

## Ask PlatformNEX for a change plan

With the key saved, Claude gets one read-only tool, `pnx_plan_change`. It is an optional extra: Claude uses it only when you ask it to plan a change **in PlatformNEX**, for example "use PlatformNEX to plan a change in speakupnex". Ordinary coding requests follow the repository's own rules.

The plan is drawn at the top of the pane (`ASK`; `m` shows it in full, `x` dismisses it): **create a ticket in ServiceNEX first**, then draft the change, approval, a linked release and a check, with the System's environments and approval gates. If asking fails, the pane says why (for example, that this PlatformNEX does not have the tool yet).

A plan is **a plan only**: nothing is created in PlatformNEX or ServiceNEX. Under a plan the pane shows **↗ Plan this in PlatformNEX (Agent mode)**: a link to the System's Components page that opens the assistant in Agent mode with `Plan: <the change>` typed and the component the pane identified as context. Opening it sends nothing; the person reads it and sends it. Claude is told to hand the same link on in its reply. The pane keeps the last five plans, cut down and capped, and never a key, token or the raw response.

Needs the gateway's `plan_propose` tool (platformnex-gateway PR #649) and, for the link, the portal's assistant links (platformnex-agentic-portal PR #439).

## If it shows an error

Run `/pnx-context check`. The usual causes:

- **Your sign-in ended**: the session is over (see the limits above). Press Sign in again.
- **the API key was not accepted**: the key is wrong, expired or revoked. Create a new one in the portal and save it again.
- **this PlatformNEX does not have the repo lookup yet**: the server you point at has not been updated. Ask the platform team, or set `baseUrl` to an environment that has it.
- **not allowed** / **not found**: your account cannot see that repository's component. This is not an error in the mod.

## What it calls

Everything is read-only except one draft release, and it uses only you: your own key, or your sign-in's short-lived token (which can read the catalog and open draft releases, nothing else). The plan tool calls the gateway's MCP proxy (`/api/catalog/mcp-proxy`), which offers read-only tools only, with a short token made from your key. See the pull request that added it for the full list. It never calls deploy, rollback, refresh or any live cost route.

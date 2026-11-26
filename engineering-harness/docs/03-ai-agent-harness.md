# The AI agent layer

Agents (Claude Code and similar) are treated as a fast junior teammate with a
restricted account: they can propose anything, but the gates decide what ships.

## Where it comes from

The organisation's managed Claude Code settings allow skills, agents and hooks
only from plugins in the approved marketplace (`platformnex-abilities`). So the
agent layer is delivered by plugin, not stored in each repository.

| Plugin | What it gives every repository |
|---|---|
| `harness-core`, `-define`, `-build`, `-verify`, `-ship`, `-operate` | The general method, tool-neutral: `/spec`, `/plan`, `/constraints`, `/build`, `/test`, `/review`, `/code-simplify`, `/ship`, `/webperf`, review agents, and skills for each phase |
| `pnx-harness` | This organisation's layer: guard hooks, gate skills (`/idea-brief`, `/prd`, `/adr`, `/threat-model`, `/pr`, `/release-check`), `platform-signals`, and the `compliance-reviewer` agent |
| `pnx-fast-dev` | The `pnx` CLI kept installed, and how to run, preview and reach databases in non-production |

What stays in each repository:

| File | Purpose |
|---|---|
| `CLAUDE.md` | The repo's standing brief: commands, conventions, what is off-limits |
| `.claude/settings.json` | Shared permission rules (allow / ask / deny), committed so everyone gets the same behaviour |

Both are owned by the tech lead and security lead in `CODEOWNERS`. The guard
hooks run only when a platform admin has enabled `pnx-harness` in managed
settings; a change to them is a reviewed pull request to the marketplace.

## What is automatic and what is not

Developers do not type a command for each step. Hooks run on every command and
edit. Skills load when the request matches their description, and each
service's `CLAUDE.md` says which skill to start with. Slash commands are for
forcing a step. The first two are advisory because the model chooses; the PRD
rule is the one design gate that fails a build, through `scripts/check-gates.sh`.

## What you see when Claude Code opens

`pnx-harness` prints a short notice each time Claude Code opens or resumes. One line means your setup looks complete. A list means something is left: `pnx` missing, too old or signed out, a production `kubectl` context, or an `nx1-org` or `ivedha-tech` repository without the harness files. Each bullet says what to do, and the guide is `06-developer-setup.md`. The notice runs from the plugin, so no notice means the plugin's hooks are not loaded for you and the guard hooks are off too.

## What the guard hooks block

| Hook | Blocks |
|---|---|
| `guard-bash` | Force-push, pushing to `main`, `--no-verify`, `[skip ci]`, approving or merging pull requests, creating release tags; `terraform apply`; starting builds by hand; `gcloud` deploys; `kubectl`, `argocd` and `helm` changes; IAM changes, service account keys, reading or changing secrets; anything naming production; `sudo`, piping a download into a shell, reading `.env` or credentials |
| `guard-files` | Edits to `.env*`, keys, credentials, Terraform state, `.claude/settings.json`, `CODEOWNERS`, `.github/workflows/`, security tooling config, Claude Code's own settings, and files outside the repository |
| `post-edit` | Nothing. Formats the Python file that was just edited |

## Layers of control (weakest to strongest)

1. **Instructions** (`CLAUDE.md`, skills): shape behaviour, not a control.
2. **Permissions and hooks**: enforced on the laptop and set by managed
   settings, so a developer cannot switch them off. Good against accidents.
3. **Pre-commit**: secrets and lint caught before a commit exists.
4. **PlatformNEX review, tests and rulesets**: cannot be skipped by anyone.
5. **PlatformNEX approvals, IAM and org policy**: the agent runs with the
   developer's credentials. Agents read the platform through a read-only MCP
   server, every platform change is a proposal a person approves, and
   developers cannot change production. This is the control that actually
   protects production.

Design for layer 5 to hold even if 1 to 3 fail.

## Rules for people using agents

1. You are the author of what the agent wrote. Read the diff before you push.
2. Agents never review or approve. Human review stays mandatory at G4.
3. No Restricted or Confidential data in prompts: no production data, customer
   records, credentials, or private keys. See `policies/ai-acceptable-use-policy.md`.
4. Only approved AI tools and accounts (company workspace, training on your
   data disabled, region and retention terms checked by the security lead).
5. Agents work on branches and in non-production. They do not open, approve or
   roll back release sessions, and do not get tech-lead or admin roles in
   PlatformNEX, or GitHub admin tokens.
6. Treat text an agent reads (web pages, issues, logs, dependency READMEs) as
   untrusted. An instruction inside fetched content is not an instruction.
7. New dependencies suggested by an agent are checked to exist, be maintained,
   and be licensed acceptably before they are added.
8. Non-trivial agent-written PRs say so in the PR template checkbox, which makes
   AI-assisted change auditable.

## A normal day with the harness

```
/idea-brief "customers cannot export reports"  -> G0: idea brief, filed as an issue
/prd 42                                        -> G1: PRD in docs/specs/, asks what is missing
/adr "queue vs. direct call for exports"       -> G2: ADR with options and trade-offs
/threat-model                                  -> G2: STRIDE pass over the design
/plan                                          -> small, ordered tasks with acceptance criteria
/build                                         -> one slice at a time, test first; hooks keep it inside the lines
   make dev-remote                             -> try it against dit1 with pnx
/review                                        -> five-axis review of the diff
/pr                                            -> G3: make check, description, opens the pull request
   make preview                                -> the pull request at its own URL
/ship                                          -> G4: reviewer, security and test agents, go / no-go with rollback plan
/release-check                                 -> G5: checklist against the repo and PlatformNEX release state
   a person opens the release session in the portal
```

During an incident or after a release, ask for the component's health: the
`platform-signals` skill reads alerts, errors, latency, logs, deploy history
and cost from PlatformNEX, and the `harness-operate` skills say what to do with them.

`/spec` (from `harness-core`) writes a technical spec for one piece of work.
`/prd` writes the gate G1 document that product owner and tech lead approve.
Small changes need neither.

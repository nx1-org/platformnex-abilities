# platformnex-abilities

The organisation's approved Claude Code Abilities (skills, agents, commands and hooks), plus the engineering kit that describes how we use them.
Managed by PlatformNEX. Every change arrives as a reviewed pull request, and merging it publishes the change to everyone who receives this marketplace.

## What is here

| Path | What it is |
|---|---|
| `.claude-plugin/marketplace.json` | The marketplace manifest: every plugin, its source and version |
| `plugins/` | The plugins themselves |
| `engineering-harness/` | The engineering kit: operating model, policies, compliance files, GitHub and GCP bootstrap, and the service template. See [the kit](engineering-harness/README.md) |
| `scripts/validate-abilities.mjs` | Structural validation of the harness bundles, run in CI |
| `evals/` | Trigger and behaviour cases for the `harness-*` bundles. Paid, not run in CI |
| `.github/workflows/` | CI: structural validation and the guard-hook self-test |

## Install

Most people receive the marketplace through the organisation's managed settings, which also decide which plugins are turned on. To add it by hand:

```
/plugin marketplace add nx1-org/platformnex-abilities
/plugin marketplace update platformnex-abilities
/plugin install <plugin>@platformnex-abilities
```

Restart the session after installing. Skills from a plugin appear namespaced, for example `/pnx-harness:prd`.

## The plugins

### Engineering harness

| Plugin | What it gives you |
|---|---|
| `harness-core` | The skill router, shared checklists, review agents and the lifecycle commands `/spec`, `/plan`, `/constraints`, `/build`, `/test`, `/review`, `/code-simplify`, `/ship`, `/webperf` |
| `harness-define`, `harness-build`, `harness-verify`, `harness-ship`, `harness-operate` | Skills for each phase, from interviewing and specs to incidents and cost review |
| `pnx-harness` | The PlatformNEX layer: guard hooks, a start-up notice listing what a developer still has to set up ([guide](engineering-harness/docs/06-developer-setup.md)), the gate skills (`idea-brief`, `prd`, `adr`, `threat-model`, `pr`, `release-check`), `platform-signals`, and a compliance reviewer |

The `harness-*` bundles are tool-neutral by design. Anything that names PlatformNEX lives in `pnx-harness` or `pnx-fast-dev`.

### PlatformNEX

| Plugin | What it gives you |
|---|---|
| `pnx-fast-dev` | Keeps the `pnx` CLI installed and current, and teaches Claude to run, preview and reach databases in non-production |

### Workflow, design and utilities

`ccw-workflow`, `bencium-ux`, `design-taste`, `frontend-design`, `playwright-skill`, `commit-message` and `plugin-dev`. Some are third-party and pinned to a commit.

Which plugins load for you, and whether a plugin's hooks run, is decided by managed settings. In particular the `pnx-harness` guard hooks do nothing until an administrator enables the plugin.

## How a change arrives

1. Branch, change, open a pull request. Nobody pushes to `main`.
2. CI runs `node scripts/validate-abilities.mjs` and the guard-hook self-test.
3. A reviewer approves it, and merging publishes it.

Removing a plugin from the manifest removes it for everyone (`forceRemoveDeletedPlugins` is on), so say so in the pull request.

## Adding or changing a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json` (`name` equal to the folder, plus `description` and `version`).
2. Add the plugin to `.claude-plugin/marketplace.json`. The version there must equal the one in `plugin.json`. Bump both on every change.
3. Write skills as `skills/<kebab-name>/SKILL.md`. The frontmatter holds `name` (equal to the folder) and a `description` under 1024 characters that says when to use it ("Use when ..."). Skills need Overview, When to Use and Verification sections and should stay under 500 lines.
4. For a `harness-*` bundle: include `LICENSE` and `NOTICE.md`, add no `hooks/` directory, and leave out terms that name a platform or another vendor's tool. The validator enforces all three.
5. For hooks, put them in `pnx-harness` or `pnx-fast-dev`, keep scripts under the plugin and reference them with `${CLAUDE_PLUGIN_ROOT}`. Any change to a guard rule needs both allow and block cases in `plugins/pnx-harness/scripts/test-hooks.sh`.
6. Run the checks below, then open the pull request.

## Checks

```bash
node scripts/validate-abilities.mjs              # structure, frontmatter, references, banned terms (free)
bash plugins/pnx-harness/scripts/test-hooks.sh   # guard-hook allow and block cases (free)
bash plugins/pnx-harness/scripts/test-session-info.sh   # the start-up notice (free)
bash engineering-harness/scripts/test-check-gates.sh   # the PRD gate used by the service template (free)
```

The model-based cases in `evals/` call a model and cost money. Run them on demand, after agreeing the cost, and cap the cases per run. [`evals/README.md`](evals/README.md) explains both kinds and how to add a case.

## The engineering kit

`engineering-harness/` holds the operating model (gates G0 to G6), nine policies, a SOC 2 and ISO 27001 control matrix, document templates, GitHub and GCP bootstrap scripts, Terraform for the GCP foundation, and the service template that new repositories start from. It is not a plugin and CI does not check it. The scripts and Terraform have not been run against a real organisation. Start with [its README](engineering-harness/README.md).

## Licences

The `harness-*` bundles and `evals/` are derived from addyosmani/agent-skills (MIT, pinned commit); the licence and notice files in each folder say so. Third-party plugins keep their own licences.

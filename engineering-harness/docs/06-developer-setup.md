# Developer setup

What to set up on your machine and in your repository so the engineering harness works for you. Claude Code's start-up notice links here.

## What the start-up notice means

Each time Claude Code opens or resumes in a repository, `pnx-harness` prints a short notice.

- **One line** ("your setup looks complete"): nothing to do.
- **A list under "Still to set up"**: each bullet is one thing below. Fix them in any order.
- **No notice at all**: the plugin's hooks are not loaded for you, so the guard hooks are off too. The plugin has to be enabled in the organisation's managed settings; ask the Claude Code administrator. Installing it by hand may not be enough.

The notice checks three things: `pnx` (installed, new enough, signed in), the current `kubectl` context (not production), and, in an `nx1-org` or `ivedha-tech` repository, the seven harness items.

## The `pnx` command line

`pnx` needs Node 20 or later. Global npm packages belong to one Node version, so use one Node everywhere. If your repository pins a version in `.nvmrc`, use that, as long as it is 20 or later.

```bash
nvm install 22 && nvm alias default 22      # or 20, if your repository pins it
```

Start Claude Code again: the `pnx-fast-dev` plugin installs and updates `pnx` in the background. To do it by hand:

```bash
gcloud auth application-default login
npm config set @platformnex:registry https://us-central1-npm.pkg.dev/ivedha-mgmt-env-nonprod/platformnex-npm/
npx --yes google-artifactregistry-auth
npm i -g @platformnex/pnx@latest
pnx help | grep "pnx dev setup"            # must print a line, or pnx is too old
```

Sign in with a personal API key from the portal (Account › API keys). Never paste the key into a chat or a file in a repository.

```bash
pnx login --catalog-url https://<portal host>/api/catalog
pnx dev doctor --fix                       # kubectl 1.31+, the GKE auth plugin, the tunnel tool
```

## Keep kubectl off production

```bash
kubectl config get-contexts -o name
kubectl config use-context <a non-production context>
```

The guard hooks block commands that change clusters, but a read-only command against a production context still runs. The notice warns when the current context's name contains `prod` (and not `nonprod`).

## Check the guard hooks are live

Ask Claude to run these exactly. Each is harmless even if the guard is off.

| Ask for | Expected |
|---|---|
| `kubectl apply --help` | refused, with a reason |
| `terraform apply -help` | refused |
| `gh pr merge --help` | refused |
| `git grep -n "kubectl apply" -- docs` | runs |
| `kubectl get namespaces` | runs |

`/hooks` lists the hooks Claude Code has loaded. Never test with a real `git push --force`, a real `kubectl apply`, or anything aimed at `main` or production.

## The repository's harness items

The notice counts seven items. The same seven are the Improve check "Set up for the engineering harness".

| Item | Where |
|---|---|
| PRD gate | `scripts/check-gates.sh` |
| PRD folder | `docs/specs/` |
| Decision records | `docs/adr/` |
| Pull request template | `.github/PULL_REQUEST_TEMPLATE.md` (or the root, or `docs/`) |
| Agent permission rules | `.claude/settings.json` |
| Skill routing | a "Which skill when" section in `CLAUDE.md` |
| Agent files under owners | a CODEOWNERS rule for `CLAUDE.md` |

**The easy way.** In PlatformNEX, open the component's Improve tab and use **Fix this** on "Set up for the engineering harness". It opens one pull request that adds what is missing and merges into what is there; it removes nothing. The check has to be switched on in Administration › Scorecards first. Until it is, ask your platform owner.

**By hand.** Copy `scripts/check-gates.sh` from this repository's `engineering-harness/repo-template/`, and add the routing section from that template's `CLAUDE.md`.

**What the pull request cannot do.** Run the gate in CI: PlatformNEX cannot add workflow files, so add a job that runs `bash scripts/check-gates.sh` on pull requests with full git history (on GitHub Actions: `fetch-depth: 0` and `BASE_REF: origin/${{ github.base_ref }}`). The check and the notice read files, not CI.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnx: command not found` after changing directory | `nvm` switched to a Node version without `pnx` | Use one Node everywhere, or install `pnx` under each |
| `pnx dev setup` is missing from `pnx help` | `pnx` 0.1.11 from Node 18 | Use Node 20 or later and restart Claude Code |
| `registry sign-in failed` | no application-default credentials | `gcloud auth application-default login` |
| `Not signed in` | `pnx login` not done | `pnx login --catalog-url https://<portal host>/api/catalog` |
| `DEV_FEATURE_OFF` | fast development is off on that environment | an admin turns it on in Administration › Environments |
| No start-up notice | plugin not enabled for you | ask the administrator |
| The notice says the repository is missing items but the files exist | the routing heading or the CODEOWNERS rule is worded differently | the notice looks for "Which skill when" in `CLAUDE.md` and a non-comment line naming `CLAUDE.md` in CODEOWNERS |

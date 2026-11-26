#!/usr/bin/env node
// Structural validation for the abilities marketplace. No dependencies, no network, free to run in CI.
// Usage: node scripts/validate-abilities.mjs [--bundle <name>]...   (default: every bundle named harness-*, plus PLATFORM_BUNDLES)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const only = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--bundle') only.push(args[++i]);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
// Terms the tool-neutral harness bundles must not contain (pnx integration is a later phase).
const BANNED = /platformnex|\bpnx\b|gemini|codex|cursor|windsurf|copilot|opencode|antigravity/i;
// Bundles that are PlatformNEX-specific by design: same structural rules, but they may name the
// platform, ship hooks, and carry no upstream licence notice.
const PLATFORM_BUNDLES = new Set(['pnx-harness']);
const REQUIRED_SECTIONS = [/^#+\s*overview/im, /^#+\s*when to use/im, /^#+\s*verification/im];
const MAX_LINES = 500;

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function frontmatter(raw) {
  const text = raw.replace(/\r\n/g, '\n'); // a Windows checkout has CRLF
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) { key = kv[1]; out[key] = kv[2].replace(/^["']|["']$/g, ''); }
    else if (key && /^\s+/.test(line)) out[key] += ' ' + line.trim();
  }
  return out;
}

const pluginsDir = join(root, 'plugins');
const bundles = readdirSync(pluginsDir)
  .filter((d) => statSync(join(pluginsDir, d)).isDirectory())
  .filter((d) => (only.length ? only.includes(d) : d.startsWith('harness-') || PLATFORM_BUNDLES.has(d)));

const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
const listed = new Map(marketplace.plugins.map((p) => [p.name, p]));

// Every skill name in the harness, for cross-reference checks.
const known = new Set();
for (const b of bundles) {
  const sd = join(pluginsDir, b, 'skills');
  if (existsSync(sd)) for (const s of readdirSync(sd)) known.add(`${b}:${s}`);
}

for (const b of bundles) {
  const dir = join(pluginsDir, b);
  const pj = join(dir, '.claude-plugin/plugin.json');
  if (!existsSync(pj)) err(`${b}: missing .claude-plugin/plugin.json`);
  else {
    try {
      const j = JSON.parse(readFileSync(pj, 'utf8'));
      if (j.name !== b) err(`${b}: plugin.json name "${j.name}" does not match directory`);
      if (!j.description || !j.version) err(`${b}: plugin.json needs description and version`);
      const entry = listed.get(b);
      if (!entry) err(`${b}: not listed in .claude-plugin/marketplace.json`);
      else if (entry.version !== j.version) err(`${b}: marketplace version ${entry.version} != plugin.json ${j.version}`);
    } catch (e) { err(`${b}: plugin.json is not valid JSON (${e.message})`); }
  }
  const platform = PLATFORM_BUNDLES.has(b);
  if (!platform) {
    for (const f of ['LICENSE', 'NOTICE.md']) if (!existsSync(join(dir, f))) err(`${b}: missing ${f}`);
    if (existsSync(join(dir, 'hooks'))) err(`${b}: hooks are held back for v1; remove the hooks directory`);
  } else if (existsSync(join(dir, 'hooks'))) {
    // Every hook command must point at a script that exists inside the bundle.
    const hj = join(dir, 'hooks/hooks.json');
    if (!existsSync(hj)) err(`${b}: hooks directory without hooks.json`);
    else {
      try {
        const text = readFileSync(hj, 'utf8');
        JSON.parse(text);
        for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g)) {
          if (!existsSync(join(dir, m[1]))) err(`${b}: hooks.json references missing file ${m[1]}`);
        }
      } catch (e) { err(`${b}: hooks.json is not valid JSON (${e.message})`); }
    }
  }

  const sd = join(dir, 'skills');
  if (existsSync(sd)) for (const s of readdirSync(sd)) {
    const sk = join(sd, s, 'SKILL.md');
    const id = `${b}/${s}`;
    if (!KEBAB.test(s)) err(`${id}: directory name must be lowercase-hyphen`);
    if (!existsSync(sk)) { err(`${id}: missing SKILL.md`); continue; }
    const text = readFileSync(sk, 'utf8');
    const fm = frontmatter(text);
    if (!fm) { err(`${id}: missing YAML frontmatter`); continue; }
    if (fm.name !== s) err(`${id}: frontmatter name "${fm.name}" must equal directory name`);
    if (!fm.description) err(`${id}: missing description`);
    else {
      if (fm.description.length > 1024) err(`${id}: description is ${fm.description.length} chars (max 1024)`);
      if (!/use (when|before|after|during|for)\b/i.test(fm.description)) err(`${id}: description needs a "Use when ..." trigger`);
    }
    for (const k of Object.keys(fm)) if (!ALLOWED_KEYS.has(k)) err(`${id}: unsupported frontmatter key "${k}"`);
    // The router is a lookup, not a process skill, so it has no When to Use / Verification sections.
    if (s !== 'using-agent-skills') for (const re of REQUIRED_SECTIONS) if (!re.test(text)) err(`${id}: missing section matching ${re}`);
    if (text.split('\n').length > MAX_LINES) warn(`${id}: over ${MAX_LINES} lines`);
    for (const m of text.matchAll(/\b(harness-[a-z]+):([a-z0-9-]+)/g)) {
      if (!known.has(`${m[1]}:${m[2]}`) && bundles.includes(m[1])) err(`${id}: references unknown skill ${m[0]}`);
      else if (!bundles.includes(m[1]) && !only.length) err(`${id}: references unknown bundle ${m[1]}`);
    }
  }

  if (platform) continue;
  // Banned terms across everything except the notice/licence.
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(dir)) {
    if (/LICENSE$|NOTICE\.md$/.test(f) || !/\.(md|json|sh|mjs|js)$/.test(f)) continue;
    const hit = readFileSync(f, 'utf8').match(BANNED);
    if (hit) err(`${f.replace(root + '/', '')}: contains banned term "${hit[0]}"`);
  }
}

// Eval coverage for the platform bundles: every skill has trigger and behaviour cases with the fields a
// runner reads, and every fire / stay-quiet check has a prompt and at least one grader. Structure only;
// running the cases calls a model and is not done here.
const allSkillNames = new Set();
for (const d of readdirSync(pluginsDir)) {
  const sd = join(pluginsDir, d, 'skills');
  if (existsSync(sd) && statSync(sd).isDirectory()) for (const s of readdirSync(sd)) allSkillNames.add(s);
}
for (const b of bundles.filter((x) => PLATFORM_BUNDLES.has(x))) {
  const sd = join(pluginsDir, b, 'skills');
  if (!existsSync(sd)) continue;
  for (const s of readdirSync(sd)) {
    const id = `${b}/${s}`;
    const cf = join(root, 'evals/cases', `${s}.json`);
    if (!existsSync(cf)) { err(`${id}: no eval cases at evals/cases/${s}.json`); continue; }
    let c;
    try { c = JSON.parse(readFileSync(cf, 'utf8')); } catch (e) { err(`${id}: evals/cases/${s}.json is not valid JSON (${e.message})`); continue; }
    if (c.skill_name !== s) err(`${id}: eval cases name "${c.skill_name}" does not match the skill`);
    const pos = c.trigger?.positive ?? [];
    const neg = c.trigger?.negative ?? [];
    if (pos.length < 3) err(`${id}: needs at least 3 positive trigger prompts (has ${pos.length})`);
    if (neg.length < 2) err(`${id}: needs at least 2 negative trigger prompts (has ${neg.length})`);
    for (const p of [...pos, ...neg]) if (!p.prompt || typeof p.prompt !== 'string') err(`${id}: a trigger entry has no prompt`);
    for (const n of neg) if (n.owner && !allSkillNames.has(n.owner)) err(`${id}: negative prompt names owner "${n.owner}", which is not a skill`);
    if (!(c.evals?.length)) err(`${id}: needs at least one behavioural eval`);
    for (const e of c.evals ?? []) {
      if (!e.prompt || !e.expected_output || !(e.expectations?.length)) err(`${id}: eval ${e.id} needs prompt, expected_output and expectations`);
      for (const f of e.files ?? []) if (!existsSync(join(root, 'evals/fixtures', f))) err(`${id}: eval ${e.id} names fixture "${f}", which does not exist`);
    }
  }
}
const checksDir = join(root, 'evals/plugin');
if (existsSync(checksDir)) {
  for (const d of readdirSync(checksDir)) {
    const dir = join(checksDir, d);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, 'prompt.md'))) err(`evals/plugin/${d}: missing prompt.md`);
    const gd = join(dir, 'graders');
    if (!existsSync(gd) || !readdirSync(gd).some((f) => f.endsWith('.md'))) err(`evals/plugin/${d}: needs at least one grader in graders/`);
  }
}

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
console.log(`${bundles.length} bundle(s), ${[...known].length} skill(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);

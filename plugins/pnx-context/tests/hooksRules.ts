// A read of the hooks' source for the rules the engine enforces when it loads the hooks module (a failure there removes the
// whole pane). Taken from the engine's own refusal messages: `$` may cross an import only into a function declaration, and
// only as an argument to a named function (never a member call or a spread); an atom is read or updated only where its own
// file defines it; a name declared in a file must not shadow one it imports. 0.10.0 broke the first two, and the engine's
// message came one rule at a time. Plain text matching, so it can miss a shape it was not written for; the real check is
// the engine loading the module.

const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'\.\/([A-Za-z0-9_]+)'/g
const MEMBER_CALL = /[\w)\]]\.[A-Za-z_]\w*\(\s*\$\s*[,)]/
const SPREAD = /\.\.\.\s*\$(?![\w.])/
const ATOM_USE = /\b(?:read|update)\(\s*\$\s*,\s*([A-Za-z_]\w*)/g

/** `files` maps a hook file name (`register.tsx`) to its text. Returns one line per problem; none means clean. */
export function hookRuleProblems(files: Record<string, string>): string[] {
  const problems: string[] = []
  const stem = (f: string): string => f.replace(/\.tsx?$/, '')

  for (const [file, source] of Object.entries(files)) {
    const imported = new Set<string>()
    for (const m of source.matchAll(IMPORT)) {
      const target = Object.entries(files).find(([f]) => stem(f) === m[2])?.[1]
      for (const raw of (m[1] ?? '').split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? ''
        if (name === '') continue
        imported.add(name)
        if (new RegExp(`^\\s*(const|let|var|function|class)\\s+${name}\\b`, 'm').test(source)) problems.push(`${file}: declares ${name} again, shadowing the import`)
        if (target !== undefined && new RegExp(`\\b${name}\\(\\s*\\$[,)\\s:]`).test(source) && !new RegExp(`^export (async )?function ${name}\\b`, 'm').test(target)) {
          problems.push(`${file}: passes $ to ${name}, which ${m[2]} does not declare with \`function\``)
        }
      }
    }
    if (MEMBER_CALL.test(source)) problems.push(`${file}: passes $ to a member call; $ goes only to a named function`)
    if (SPREAD.test(source)) problems.push(`${file}: passes $ in a spread`)
    for (const m of source.matchAll(ATOM_USE)) {
      const name = m[1] ?? ''
      if (!new RegExp(`^(export )?const ${name} = atom\\(`, 'm').test(source)) {
        problems.push(`${file}: reads or updates ${name}, which this file does not define with atom()${imported.has(name) ? ' (it is imported)' : ''}`)
      }
    }
  }

  return problems
}

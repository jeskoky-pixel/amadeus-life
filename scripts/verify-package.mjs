/**
 * Privacy and package-content verifier.
 *
 * This checks the files npm would include from package.json's `files` whitelist.
 * It deliberately fails on private Creator/workspace identifiers, absolute
 * user paths, credentials, raw SQLite/log artifacts, and internal handoff or
 * verification evidence. Run with `npm run verify:package`; it is also part of
 * `npm run package`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FORBIDDEN_PATHS = [
  /(^|\/)HANDOFF\.md$/i,
  /(^|\/)\.productization-task(\/|$)/i,
  /(^|\/)docs\/verification(\/|$)/i,
  /(^|\/)docs\/tasks(\/|$)/i,
  /(^|\/)docs\/contracts(\/|$)/i,
  /(^|\/)docs\/adr(\/|$)/i,
  /(^|\/)test(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.npm-cache(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)backups?(\/|$)/i,
  /\.(sqlite|sqlite-wal|sqlite-shm|db|log|pem|key)$/i,
]

// Private identities must not appear in user-facing tracked/package text.
const CONTENT_RULES = [
  {
    name: 'private-session-or-workspace-uuid',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
  {
    name: 'private-session-id',
    re: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
  {
    name: 'absolute-user-path',
    re: /(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/[^/\s]+\/|AMADEUS_ROOT)/i,
  },
  {
    name: 'credential',
    re: /(?:sk-[A-Za-z0-9]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization:\s*bearer\s+\S+|(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"']+["'])/i,
  },
]

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else if (stat.isFile()) out.push(path)
  }
  return out
}

function expand(pattern) {
  if (!pattern.includes('*')) {
    const path = resolve(root, pattern)
    return statSync(path).isDirectory() ? walk(path) : [path]
  }
  const directory = resolve(root, dirname(pattern))
  const filePattern = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => filePattern.test(name))
    .map((name) => join(directory, name))
}

/** @returns {string[]} expected package-relative files, sorted. */
export function expectedPackageFiles() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const files = new Set()
  for (const pattern of pkg.files) {
    for (const file of expand(pattern)) files.add(relative(root, file).split('\\').join('/'))
  }
  files.add('package.json')
  return [...files].sort()
}

/** @param {string} file @returns {boolean} */
export function isForbiddenPackagePath(file) {
  return FORBIDDEN_PATHS.some((re) => re.test(file))
}

/** @param {string} text @param {string} file @returns {string[]} issue labels. */
export function scanText(text, file = '<text>') {
  const issues = []
  for (const rule of CONTENT_RULES) {
    if (rule.re.test(text)) issues.push(`${rule.name}: ${file}`)
  }
  return issues
}

/** @returns {{ok: boolean, files: string[], issues: string[]}} */
export function verifyPackage() {
  const files = expectedPackageFiles()
  const issues = []
  for (const file of files) {
    if (isForbiddenPackagePath(file)) issues.push(`forbidden-package-path: ${file}`)
    const absolute = join(root, file)
    if (!existsSync(absolute)) {
      issues.push(`missing-package-file: ${file}`)
      continue
    }
    if (!/\.(?:md|json|js|mjs|cjs|yml|yaml|txt|svg)$/i.test(file)) continue
    // The verifier necessarily contains the pattern literals; do not flag its
    // own source. It is build tooling, not user-facing runtime content.
    if (file === 'scripts/verify-package.mjs') continue
    const text = readFileSync(absolute, 'utf8')
    issues.push(...scanText(text, file))
  }
  const required = [
    'README.md',
    'docs/USER_GUIDE.md',
    'docs/INSTALL.md',
    'docs/UPGRADE.md',
    'docs/BACKUP.md',
    'docs/BUILD.md',
    'docs/RELEASE_NOTES.md',
    'docs/SETUP.md',
    'src/index.js',
    'lib/client.js',
    'scripts/life-backup.mjs',
    'cordis.patch.yml',
    'icon.svg',
  ]
  for (const file of required) if (!files.includes(file)) issues.push(`missing-required-file: ${file}`)
  return { ok: issues.length === 0, files, issues }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPackage()
  if (!result.ok) {
    console.error('Package privacy/content check failed:')
    for (const issue of result.issues) console.error(`- ${issue}`)
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ ok: true, files: result.files.length, checked: result.files }, null, 2))
  }
}

/**
 * Build the versioned Life tarball without publishing or installing it.
 * Usage: npm run package
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dist = join(root, 'dist')
const cache = join(root, '.npm-cache')
mkdirSync(dist, { recursive: true })
mkdirSync(cache, { recursive: true })
const tarball = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`
const target = join(dist, tarball)

// npm pack honors package.json `files`. Keep npm's cache inside the workspace so
// this never writes a profile or a home-directory cache. It is local only.
const env = { ...process.env, SOURCE_DATE_EPOCH: '1792886400', TZ: 'UTC' }
if (process.platform === 'win32') {
  const shell = process.env.ComSpec || 'cmd.exe'
  execFileSync(shell, ['/d', '/s', '/c', 'npm pack --cache .npm-cache --pack-destination dist'], {
    cwd: root, stdio: 'inherit', env,
  })
} else {
  execFileSync('npm', ['pack', '--cache', '.npm-cache', '--pack-destination', 'dist'], { cwd: root, stdio: 'inherit', env })
}
if (!existsSync(target)) {
  const produced = readdirSync(dist).filter((name) => name.endsWith('.tgz')).sort()
  if (produced.length === 0) throw new Error('npm pack did not produce a tarball')
  const latest = join(dist, produced[produced.length - 1])
  const hash = createHash('sha256').update(readFileSync(latest)).digest('hex')
  writeFileSync(join(dist, `${tarball}.sha256`), `${hash}  ${produced[produced.length - 1]}\n`)
  writeFileSync(join(dist, 'life-package.json'), `${JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    tarball: produced[produced.length - 1],
    sha256: hash,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`)
  process.stdout.write(`${latest}\nSHA256 ${hash}\n`)
  process.exit(0)
}
const hash = createHash('sha256').update(readFileSync(target)).digest('hex')
writeFileSync(join(dist, `${tarball}.sha256`), `${hash}  ${tarball}\n`)
writeFileSync(join(dist, 'life-package.json'), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  tarball,
  sha256: hash,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`)
process.stdout.write(`${target}\nSHA256 ${hash}\n`)

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expectedPackageFiles,
  isForbiddenPackagePath,
  scanText,
  verifyPackage,
} from '../scripts/verify-package.mjs'

test('PRIV1 scanner rejects private session/workspace IDs, absolute user paths, credentials, and log paths', () => {
  assert.match(scanText('session-11111111-2222-4333-8444-555555555555', 'bad.txt').join(' '), /private-session-id/)
  assert.match(scanText('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'bad.txt').join(' '), /workspace-uuid/)
  assert.match(scanText('C:\\Users\\alice\\life\\life.sqlite', 'bad.txt').join(' '), /absolute-user-path/)
  assert.match(scanText('C:/Users/alice/private', 'bad.txt').join(' '), /absolute-user-path/)
  assert.match(scanText('/home/alice/private', 'bad.txt').join(' '), /absolute-user-path/)
  assert.match(scanText('api_key = "sk-abcdefghijklmnop"', 'bad.txt').join(' '), /credential/)
  assert.match(scanText('-----BEGIN PRIVATE KEY-----', 'bad.txt').join(' '), /credential/)
  assert.equal(isForbiddenPackagePath('HANDOFF.md'), true)
  assert.equal(isForbiddenPackagePath('docs/verification/REPORT.md'), true)
  assert.equal(isForbiddenPackagePath('test/life-core.test.js'), true)
  assert.equal(isForbiddenPackagePath('logs/life.log'), true)
  assert.equal(isForbiddenPackagePath('src/index.js'), false)
})

test('PRIV2 package whitelist is user-facing and contains no internal handoff/Creator evidence', () => {
  const result = verifyPackage()
  assert.equal(result.ok, true, result.issues.join('\n'))
  for (const file of result.files) {
    assert.equal(isForbiddenPackagePath(file), false, `forbidden package file ${file}`)
  }
  const files = expectedPackageFiles()
  assert.ok(files.includes('docs/USER_GUIDE.md'))
  assert.ok(files.includes('docs/BACKUP.md'))
  assert.ok(files.includes('docs/RELEASE_NOTES.md'))
  assert.ok(files.includes('scripts/life-backup.mjs'))
  assert.ok(files.includes('lib/client.js'))
  assert.equal(files.includes('HANDOFF.md'), false)
  assert.equal(files.some((file) => file.startsWith('docs/verification/')), false)
  assert.equal(files.some((file) => file.startsWith('test/')), false)
  assert.equal(files.some((file) => file.startsWith('docs/adr/')), false)
})

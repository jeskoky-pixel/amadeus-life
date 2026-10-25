/**
 * Build the browser half as a DSH lazy-CJS module from the readable template.
 * No npm build dependency is required.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { publicFieldMetadata } from '../src/config-fields.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const template = readFileSync(join(root, 'src', 'client', 'factory.template.js'), 'utf8')
const logic = readFileSync(join(root, 'src', 'client', 'logic.js'), 'utf8').replace(/^export\s+/gm, '')
const fields = JSON.stringify(publicFieldMetadata(), null, 2)
let body = template.replace('__LIFE_FIELDS__', fields).replace('__CLIENT_LOGIC__', logic)
if (body.includes('__LIFE_FIELDS__') || body.includes('__CLIENT_LOGIC__')) {
  throw new Error('client template placeholders were not fully replaced')
}
if (/^\s*(import|export)\s/m.test(body)) throw new Error('client factory must not contain ESM statements')

const bundle = `window.__ModuleLoader__.load({
  id: '@amadeus/life',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
${body}
  }
});
`
new vm.Script(bundle, { filename: 'lib/client.js' })
for (const marker of ['settings.section', 'configForms', 'amadeus-life', 'Amadeus Life']) {
  if (!bundle.includes(marker)) throw new Error(`client bundle is missing ${marker}`)
}
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), bundle, 'utf8')
process.stdout.write(`built lib/client.js (${Buffer.byteLength(bundle)} bytes, ${publicFieldMetadata().length} fields)\n`)

# Build and package

Life is dependency-free at runtime. Build the browser module and package without publishing:

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.2.0.tgz -Algorithm SHA256
```

- `npm run build` reads `src/client/factory.template.js` and `src/client/logic.js`, injects the Config field metadata, validates the generated lazy-CJS module with `vm.Script`, and writes `lib/client.js`.
- `npm run package` uses workspace-local `.npm-cache` and `npm pack`; for v1.2.0 it creates `dist/amadeus-life-1.2.0.tgz`, `.sha256`, and `life-package.json`. It never publishes, installs, or edits DSH settings.
- The package manifest includes `src`, `lib`, `scripts`, `docs`, `test`, locale files, icon, README, and HANDOFF. Databases, backups, logs, `node_modules`, and productization scratch files are not packaged.

## Package checks

```powershell
tar -tf dist/amadeus-life-1.2.0.tgz
```

Verify it contains at least:

- `package/src/index.js`
- `package/lib/client.js`
- `package/src/config-schema.js`
- `package/locale/zh.json`, `package/locale/en.json`
- `package/icon.svg`
- `package/docs/USER_GUIDE.md`

The repository uses the MIT license. `private:true` remains in the manifest because the planned v1.2 install source is a fixed GitHub Release tarball, not npm. Public Release creation still requires the owner's final approval.

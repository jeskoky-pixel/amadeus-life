# Build and package

Life is dependency-free at runtime. Build the browser module and package without publishing:

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.0.1.tgz -Algorithm SHA256
```

- `npm run build` reads `src/client/factory.template.js` and `src/client/logic.js`, injects the Config field metadata, validates the generated lazy-CJS module with `vm.Script`, and writes `lib/client.js`.
- `npm run package` uses workspace-local `.npm-cache` and `npm pack`; it creates `dist/amadeus-life-1.0.1.tgz`, `.sha256`, and `life-package.json`. It never publishes, installs, or edits DSH settings.
- The package manifest includes `src`, `lib`, `scripts`, `docs`, `test`, locale files, icon, README, and HANDOFF. Databases, backups, logs, `node_modules`, and productization scratch files are not packaged.

## Package checks

```powershell
tar -tf dist/amadeus-life-1.0.1.tgz
```

Verify it contains at least:

- `package/src/index.js`
- `package/lib/client.js`
- `package/src/config-schema.js`
- `package/locale/zh.json`, `package/locale/en.json`
- `package/icon.svg`
- `package/docs/USER_GUIDE.md`

The package is not a public npm release and has no chosen license; the manifest marks it `UNLICENSED`/private pending the owner's release decision.

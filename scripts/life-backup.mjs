#!/usr/bin/env node
/**
 * CLI wrapper for isolated Life SQLite backup/verify/list/restore.
 * Usage:
 *   node scripts/life-backup.mjs backup --database <path> [--out <dir>]
 *   node scripts/life-backup.mjs verify --file <backup>
 *   node scripts/life-backup.mjs list --dir <backup-dir>
 *   node scripts/life-backup.mjs restore --backup <file> --database <path> [--dry-run]
 */
import { runCli } from '../src/backup.js'

try {
  runCli(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

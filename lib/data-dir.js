// Where the practice data lives.
//
// Nothing the app reads that isn't code — your log, your problem catalog —
// belongs in the source tree. It all sits in one directory instead, named by
// ALGO_DATA_DIR and defaulting to ./data (which is gitignored), so the code
// can be shared without shipping either.
//
//   <ALGO_DATA_DIR>/catalog.json          the problems to draw from
//   <ALGO_DATA_DIR>/state.json            the log
//   <ALGO_DATA_DIR>/state.snapshots.json  recent revisions, for recovery
//
// A relative ALGO_DATA_DIR resolves against the repository, so
// `ALGO_DATA_DIR=examples npm run dev` runs the app on the bundled sample data
// without touching anything of yours.
//
// Legacy fallback: earlier versions kept the log at the repository root, as
// grind-tracker-state.json. If the data directory has no state.json and that
// old file is still there, the old pair is read and written instead — an
// existing install keeps running until its files are moved.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const dataDirFor = (root = REPO_ROOT) =>
  path.resolve(root, process.env.ALGO_DATA_DIR || 'data')

const LEGACY_STATE = 'grind-tracker-state.json'
const LEGACY_SNAPSHOTS = 'grind-tracker-state.snapshots.json'

// Resolved once per call and used for BOTH reads and writes, so a fallback
// install never reads one file and writes another.
export function resolveData(root = REPO_ROOT) {
  const dir = dataDirFor(root)
  const statePath = path.join(dir, 'state.json')
  const legacyState = path.join(root, LEGACY_STATE)
  const legacy = !fs.existsSync(statePath) && fs.existsSync(legacyState)
  return {
    dir,
    legacy,
    catalogPath: path.join(dir, 'catalog.json'),
    statePath: legacy ? legacyState : statePath,
    snapshotsPath: legacy ? path.join(root, LEGACY_SNAPSHOTS) : path.join(dir, 'state.snapshots.json'),
  }
}

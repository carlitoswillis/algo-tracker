// The one place the catalog rows enter the program.
//
// Under Node — the standalone server, the Vite dev middleware, the scripts —
// this reads <ALGO_DATA_DIR>/catalog.json off disk. A browser has no disk, so
// vite.config.js swaps this module for the same object inlined at build time,
// and `npm run ext:sync` writes a generated copy for the extension. Every
// consumer sees one shape either way, and only this file knows the difference.
import fs from 'node:fs'
import { resolveData } from './data-dir.js'

export const EMPTY = { version: 1, linkTemplate: null, libraryUrl: null, aliases: [], problems: [] }

// A missing catalog is not an error: the app runs, the log still works, and
// nothing is served. Point ALGO_DATA_DIR at examples/ to see it with problems.
export function readCatalog(root) {
  const { catalogPath } = resolveData(root)
  if (!fs.existsSync(catalogPath)) return { ...EMPTY }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))
  } catch (err) {
    throw new Error(`${catalogPath} is not valid JSON: ${err.message}`)
  }
  const data = { ...EMPTY, ...parsed }
  // ALGO_LINK_TEMPLATE overrides the catalog's own link template, so the same
  // catalog can be opened against whatever site you actually practise on.
  if (process.env.ALGO_LINK_TEMPLATE) data.linkTemplate = process.env.ALGO_LINK_TEMPLATE
  return data
}

export const CATALOG_DATA = readCatalog()

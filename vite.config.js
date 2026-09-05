import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { handleStateRequest } from './lib/local-state.js'
import { handlePlanRequest } from './lib/plan-api.js'
import { readCatalog } from './lib/problem-data.js'
import { resolveData } from './lib/data-dir.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// lib/problem-data.js reads the catalog off disk, which a browser cannot do.
// For the client bundle it is replaced by the same object inlined at build
// time, read from the same file through the same function — so the page and
// the server can't disagree about what the catalog says.
const DATA_MODULE = '\0algo-problem-data'
const problemData = () => ({
  name: 'algo-problem-data',
  enforce: 'pre',
  resolveId(id) {
    if (id === './problem-data.js' || id.endsWith('/lib/problem-data.js')) return DATA_MODULE
    return null
  },
  load(id) {
    if (id !== DATA_MODULE) return null
    return `export const CATALOG_DATA = ${JSON.stringify(readCatalog(__dirname))}\n`
  },
  configResolved() {
    const { dir, catalogPath, statePath, legacy } = resolveData(__dirname)
    const n = readCatalog(__dirname).problems?.length ?? 0
    console.log(`  data dir  ${dir}`)
    console.log(`  catalog   ${n.toLocaleString()} problems${n ? '' : ` (none at ${catalogPath})`}`)
    console.log(`  log       ${statePath}${legacy ? '  (legacy location)' : ''}`)
  },
})

export default defineConfig({
  plugins: [
    problemData(),
    react(),
    {
      name: 'state-api',
      // Backs /api/state (and the read-only /api/plan) with a local file in
      // dev, using the SAME handlers (lib/local-state.js, lib/plan-api.js) as
      // the standalone production server (server.mjs), which in turn use the
      // SAME write contract (lib/state-contract.js). If any of the three
      // disagree about how writes are validated, the bug only shows up after a
      // deploy.
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (handleStateRequest(req, res, { dir: __dirname })) return
          if (handlePlanRequest(req, res, { dir: __dirname })) return
          next()
        })
      }
    }
  ],
  server: {
    port: 3000
  }
})

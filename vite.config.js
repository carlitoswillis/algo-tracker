import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const filePath = resolve(__dirname, 'grind-tracker-state.json')

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'state-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/api/state') {
            if (req.method === 'GET') {
              if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8')
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(data)
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('{}')
              }
            } else if (req.method === 'POST') {
              let body = ''
              req.on('data', chunk => { body += chunk })
              req.on('end', () => {
                try {
                  // Verify it is valid JSON before writing to disk
                  JSON.parse(body)
                  fs.writeFileSync(filePath, body, 'utf-8')
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: true }))
                } catch (e) {
                  res.writeHead(400, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: 'Invalid JSON' }))
                }
              })
            }
          } else {
            next()
          }
        })
      }
    }
  ],
  server: {
    port: 3000,
    open: true
  }
})

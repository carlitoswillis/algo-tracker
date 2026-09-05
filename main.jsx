import React from 'react'
import ReactDOM from 'react-dom/client'
import GrindTracker from './interview-grind-tracker.jsx'
import { createStorage } from './lib/browser-storage.js'

// window.storage is provided when running inside the Claude artifact sandbox.
// Everywhere else, back it with /api/state — see lib/browser-storage.js for why
// a backup read is reported as such rather than passed off as authoritative.
if (!window.storage) window.storage = createStorage()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GrindTracker />
  </React.StrictMode>,
)

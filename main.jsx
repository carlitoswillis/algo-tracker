import React from 'react'
import ReactDOM from 'react-dom/client'
import GrindTracker from './interview-grind-tracker.jsx'

// Polyfill window.storage if it does not exist (e.g. running in standard browser dev mode)
if (!window.storage) {
  window.storage = {
    get: async (key) => {
      try {
        const res = await fetch('/api/state')
        const text = await res.text()
        return { value: text }
      } catch (e) {
        console.error("Failed to read from local file state", e)
        return null;
      }
    },
    set: async (key, value) => {
      try {
        await fetch('/api/state', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: value, // value is already JSON.stringify(state) in the component
        })
      } catch (e) {
        console.error("Failed to write to local file state", e)
      }
    }
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GrindTracker />
  </React.StrictMode>,
)

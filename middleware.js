import { next } from '@vercel/edge'

// Gate the entire site behind a single owner password using HTTP Basic Auth.
// The password lives only in the APP_PASSWORD env var (set in the Vercel
// dashboard) — it is never shipped in the client bundle.
export const config = {
  // Match everything except Vercel internals. The browser resends the
  // Authorization header on every subresource, so gating all paths is fine.
  matcher: '/((?!_vercel/).*)',
}

// Constant-time-ish comparison so we don't leak the password via timing.
function safeEqual(a, b) {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

export default function middleware(request) {
  const password = process.env.APP_PASSWORD

  // Fail closed: if the password isn't configured, don't serve the app.
  if (!password) {
    return new Response('APP_PASSWORD is not configured.', { status: 503 })
  }

  const auth = request.headers.get('authorization') || ''
  const [scheme, encoded] = auth.split(' ')

  if (scheme === 'Basic' && encoded) {
    const decoded = atob(encoded)
    const supplied = decoded.slice(decoded.indexOf(':') + 1)
    if (safeEqual(supplied, password)) {
      return next()
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Grind Log", charset="UTF-8"',
    },
  })
}

/** Thrown when the server rejects our token — the app clears the session on this. */
export class AuthError extends Error {}

async function authed(token, path, init = {}) {
  const r = await fetch(path, {
    ...init,
    headers: { ...init.headers, Authorization: 'Bearer ' + token },
  })
  if (r.status === 401) throw new AuthError('Session expired')
  return r
}

export async function login(username, password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!r.ok) throw new Error('Invalid credentials')
  return r.json()          // { token, read_secs }
}

/** Save a quiz. `run` false saves it without spawning a room, and resolves to
 *  null instead of a room code. */
export async function createQuiz(token, quiz, run = true) {
  const r = await authed(token, `/api/quiz${run ? '' : '?run=false'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quiz),
  })
  if (!r.ok) {
    let msg = run ? 'Could not create the room' : 'Could not save the quiz'
    try {
      const body = await r.json()
      msg = body.detail?.[0]?.msg || body.detail || msg
    } catch { /* keep the default */ }
    throw new Error(msg)
  }
  return (await r.json()).room_code
}

/** Dashboard feed: live rooms + one row per quiz. Names and counts only —
 *  question content never crosses the wire. */
export async function activity(token) {
  const r = await authed(token, '/api/activity')
  if (!r.ok) throw new Error('Could not load your quizzes')
  return r.json()
}

/** Full definition, only when a quiz is actually opened for editing. */
export async function savedQuiz(token, id) {
  const r = await authed(token, `/api/quizzes/${id}`)
  if (!r.ok) throw new Error('Could not open that quiz')
  return r.json()
}

/** Runs it server-side, so the questions never reach the browser. */
export async function runSavedQuiz(token, id) {
  const r = await authed(token, `/api/quizzes/${id}/run`, { method: 'POST' })
  if (!r.ok) throw new Error('Could not start that quiz')
  return (await r.json()).room_code
}

export async function deleteQuiz(token, id) {
  const r = await authed(token, `/api/quizzes/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error('Could not delete that quiz')
}

export async function downloadCsv(token, code) {
  const r = await authed(token, `/api/room/${code}/csv`)
  if (!r.ok) throw new Error('No results available for that room')
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `${code}_results.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

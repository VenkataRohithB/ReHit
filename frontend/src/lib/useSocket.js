import { useEffect, useRef, useState } from 'react'

// Managed WebSocket with auto-reconnect. Reconnecting with the same player email
// re-joins the room server-side (kept as a reconnect, score preserved).
//
// Two things here are load-bearing for a full classroom, and both were learned
// the hard way:
//
//  * Backoff is exponential AND jittered. A fixed retry beat means 70 phones that
//    dropped together come back together, forever, in lockstep — which is a
//    self-inflicted DDoS on whatever tunnel or laptop is in front of them. That
//    is what stops a room recovering once it wobbles.
//  * There is an application-level heartbeat. A phone that locks, or walks out of
//    wifi range, leaves a half-open TCP connection: no close event, no error,
//    just silence. Without a heartbeat that student sits frozen on a stale
//    question for minutes while the class moves on.
const PING_MS = 10000     // how often we prove the link is alive
const MAX_BACKOFF = 15000

export function useSocket(url, onMessage) {
  const ref = useRef(null)
  const cb = useRef(onMessage)
  cb.current = onMessage
  const [status, setStatus] = useState('idle')

  useEffect(() => {
    if (!url) return
    let alive = true
    let retry = null
    let beat = null
    let tries = 0

    const connect = () => {
      const ws = new WebSocket(url)
      ref.current = ws
      setStatus('connecting')
      let answered = true         // did anything arrive since the last ping?

      ws.onopen = () => {
        if (!alive) return
        tries = 0
        setStatus('open')
        beat = setInterval(() => {
          if (!answered) return ws.close()   // silent for a full round — it's dead
          answered = false
          ws.send('{"type":"ping"}')
        }, PING_MS)
      }
      ws.onmessage = (e) => {
        answered = true                      // any frame at all proves liveness
        try {
          const m = JSON.parse(e.data)
          if (m.type !== 'pong') cb.current(m)
        } catch { /* ignore a frame we can't parse */ }
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        clearInterval(beat)
        if (!alive) return
        setStatus('closed')
        // 1s, 2s, 4s, 8s, capped at 15s — then ±40% so the room doesn't stampede
        const wait = Math.min(MAX_BACKOFF, 1000 * 2 ** tries++) * (0.6 + Math.random() * 0.8)
        retry = setTimeout(connect, wait)
      }
    }
    connect()

    return () => {
      alive = false
      clearTimeout(retry)
      clearInterval(beat)
      if (ref.current) ref.current.close()
    }
  }, [url])

  /** Returns false when it could not go out. Callers MUST check: silently
   *  dropping an answer and then showing "locked in" costs someone their score. */
  const send = (obj) => {
    const ws = ref.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(obj))
    return true
  }
  return { status, send }
}

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { wsUrl, roomInfo } from '../lib/api.js'
import { useSocket } from '../lib/useSocket.js'
import {
  Screen, Button, TimerBar, OptionKey, Leaderboard, QuestionMedia, Ticker, faceOf, clock,
  tone, useCountdown, useStopwatch, Logo, QuizTagline,
} from '../ui.jsx'

/* Stable per-device id, shared across every room. It identifies a seat to the
   server that issued it and is never shown to anyone.

   Global, not per-room: a per-room id would be reminted on joining a second room,
   which in name mode locks you out of your own name. And randomUUID is a
   secure-context API — undefined on plain http, which is exactly how this gets
   hosted for a class — hence the fallback. */
const deviceId = () => {
  let d = localStorage.getItem('quiz.device')
  if (!d) {
    d = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem('quiz.device', d)
  }
  return d
}

export default function Play() {
  const { code } = useParams()
  // survive a refresh: the room remembers the seat, so rejoining restores the score
  const SEAT = `quiz.seat.${code}`
  const saved = localStorage.getItem(SEAT) || ''
  const [typed, setTyped] = useState(saved)     // what is in the join field
  const [joined, setJoined] = useState(!!saved)
  const [identity, setIdentity] = useState(null)  // 'email' | 'name' | 'anonymous'
  const [myName, setMyName] = useState(saved)     // resolved by the server on join
  const [err, setErr] = useState('')
  const [lobby, setLobby] = useState({ count: 0, capacity: 0 })
  const [view, setView] = useState({ screen: 'lobby' })
  const [picked, setPicked] = useState(null)     // confirmed sent to the server
  const [pending, setPending] = useState(null)   // tapped, but the socket was down

  const onMsg = useCallback((m) => {
    switch (m.type) {
      case 'error':
        setErr(m.msg); setJoined(false); localStorage.removeItem(SEAT); break
      case 'joined':
        // the server resolves the final name: anonymous mode assigns one, and a
        // typed one may have been trimmed
        setErr(''); setMyName(m.name); localStorage.setItem(SEAT, m.name); break
      case 'lobby':
        setLobby(m)
        // between questions the room goes back to the join screen, so a phone
        // still sitting on the last leaderboard comes back with it
        if (m.state === 'waiting') { setView({ screen: 'lobby' }); setPicked(null); setPending(null) }
        break
      case 'question':
        // your_answer is present when we refreshed after already answering
        setPicked(m.your_answer ?? null); setPending(null)
        setView({ screen: 'question', ...m }); break
      case 'results': setView({ screen: 'results', ...m }); break
      // the standings arrive separately, when the host reveals them — merged in
      // so the results screen keeps everything it was already showing
      case 'board': setView((v) => ({ ...v, screen: 'results', ...m })); break
      case 'game_over': setView({ screen: 'over', ...m }); break
      default: break
    }
  }, [SEAT])

  // which kind of name this room wants, before we ask for anything
  useEffect(() => { roomInfo(code).then((r) => setIdentity(r.identity)).catch(() => {}) }, [code])

  // in email mode the seat IS the address; otherwise it is the device, which is
  // what lets a name clash be refused without costing anyone their score
  const seat = identity === 'email' ? typed.trim().toLowerCase() : deviceId()
  const url = joined
    ? wsUrl(`/ws/play/${code}?seat=${encodeURIComponent(seat)}` +
            `&name=${encodeURIComponent(identity === 'name' ? typed.trim() : '')}`)
    : null
  const { status, send } = useSocket(url, onMsg)
  const isQuestion = view.screen === 'question'
  const reading = isQuestion && view.phase === 'reading'
  // key on the phase as well as the index so the clock restarts at the reveal
  const timeLeft = useCountdown(isQuestion ? view.remaining : null, view.window ?? 0,
    `${view.index}:${view.phase}`)
  const elapsed = useStopwatch(isQuestion ? view.elapsed : null, `${view.index}:${view.phase}`)
  // an open (host-closed) question sends no `remaining`, and useCountdown returns 0
  // for that — without this clause every tile would lock the instant it appeared
  const timeUp = isQuestion && !reading && view.remaining != null && timeLeft <= 0
  const scored = view.your_score != null

  const doJoin = (e) => {
    e.preventDefault()
    if (identity !== 'anonymous' && !typed.trim()) {
      setErr(identity === 'name' ? 'Enter a name to join' : 'Enter your email to join')
      return
    }
    setJoined(true)
  }
  const answer = (i) => {
    if (picked != null) return
    // Only lock the tiles once the server has actually got it. Locking on the tap
    // and letting a closed socket swallow the answer is how someone ends up
    // staring at "Locked in" and scoring zero.
    if (send({ type: 'answer', option: i })) { setPicked(i); setPending(null) }
    else setPending(i)
  }

  // Reconnected with an undelivered answer and the question is still open — send it.
  useEffect(() => {
    if (status !== 'open' || pending == null) return
    if (!isQuestion || reading) return
    if (send({ type: 'answer', option: pending })) { setPicked(pending); setPending(null) }
  }, [status, pending, isQuestion, reading, view.index])

  /* ---------- join ---------- */
  if (!joined) {
    return (
      <Screen>
        <div className="flex flex-none items-center justify-between text-sm font-extrabold
          tracking-[.08em] text-anchor">
          <span>{code}</span>
        </div>
        <form onSubmit={doJoin} className="flex flex-1 flex-col justify-center gap-4 text-center">
          <div className="logo-enter flex flex-col items-center gap-3">
          <h1 className="text-[clamp(1.7rem,8vw,2.4rem)]"><Logo /></h1>
          <QuizTagline />
        </div>
        <p className="font-semibold text-muted">Join the quiz</p>
          {/* one field, or none — an anonymous room asks for nothing at all */}
          {identity === 'email' && (
            <input autoFocus type="email" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="you@atria.edu" aria-label="Your email"
              className="rounded-2xl border-2 border-line px-5 py-4 text-left text-lg
                outline-none placeholder:text-muted/60 focus:border-anchor" />
          )}
          {identity === 'name' && (
            <input autoFocus type="text" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="Your name" aria-label="Your name" maxLength={24}
              className="rounded-2xl border-2 border-line px-5 py-4 text-left text-lg
                outline-none placeholder:text-muted/60 focus:border-anchor" />
          )}
          {identity === 'anonymous' && (
            <p className="text-muted">You'll get a name to play under — nothing to type.</p>
          )}
          <Button type="submit" className="py-4 text-lg" disabled={!identity}>Join</Button>
          {err && <p role="alert" className="font-semibold text-rose-ink">{err}</p>}
        </form>
      </Screen>
    )
  }

  /* ---------- in the room ---------- */
  return (
    <Screen>
      <div className="flex flex-none items-center justify-between text-sm font-extrabold
        tracking-[.08em] text-anchor">
        <span>{code}</span>
        {status !== 'open' && <span className="text-peach-ink">Reconnecting…</span>}
        {isQuestion && !reading && (view.remaining != null
          ? <span className={`text-2xl font-extrabold tabular-nums
              ${timeLeft <= 5 ? 'text-rose-ink' : 'text-ink'}`}>{Math.ceil(timeLeft)}</span>
          // counting up, so nothing is running out and nothing is urgent
          : <span className="text-2xl font-extrabold tabular-nums text-muted">{clock(elapsed)}</span>
        )}
      </div>

      {view.screen === 'lobby' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Logo className="mb-3 text-xl" />
          <div className="text-[clamp(3rem,18vw,6rem)] font-extrabold tabular-nums text-anchor">
            {lobby.count}
          </div>
          <p className="text-muted">
            {lobby.count === 1 ? 'player is' : 'players are'} in the room
          </p>
          <p className="mt-4 font-semibold">Waiting for the host to start…</p>
          <p className="text-sm text-muted">{myName}</p>
          {lobby.state === 'waiting' && (
            <p className="text-sm text-muted">The next question is coming up.</p>
          )}
        </div>
      )}

      {view.screen === 'question' && reading && (
        <>
          <TimerBar remaining={view.remaining} total={view.window} qkey={`r${view.index}`} />
          <h2 className="flex-none text-[clamp(1.35rem,6vw,1.9rem)] font-extrabold leading-tight
            tracking-tight text-balance">{view.text}</h2>
          <QuestionMedia code={view.code} image={view.image} />
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="text-[clamp(2.6rem,16vw,4.5rem)] font-extrabold tabular-nums text-anchor">
              {Math.ceil(timeLeft)}
            </div>
            <p className="font-semibold text-muted">Read the question…</p>
            <p className="text-sm text-muted">Options open when this hits zero</p>
          </div>
        </>
      )}

      {view.screen === 'question' && !reading && (
        <>
          {view.remaining != null && <TimerBar remaining={view.remaining} total={view.window} qkey={view.index} />}
          <h2 className="flex-none text-[clamp(1.35rem,6vw,1.9rem)] font-extrabold leading-tight
            tracking-tight text-balance">{view.text}</h2>
          <QuestionMedia code={view.code} image={view.image} />
          <div className="flex flex-1 flex-col justify-center gap-3">
            {view.options.map((opt, i) => {
              const t = tone(i)
              const isPick = picked === i || pending === i
              // a pending tap does NOT lock — re-tapping is how you retry
              const locked = picked != null || timeUp
              return (
                <button key={i} onClick={() => answer(i)} disabled={locked}
                  style={{ animationDelay: `${i * 70}ms` }}
                  className={`anim-pop flex min-h-14 items-center gap-3 rounded-3xl px-4 py-4 text-left
                    text-[clamp(1rem,4.4vw,1.3rem)] font-semibold transition
                    ${t.fill} ${t.ink}
                    ${locked ? '' : 'active:scale-[.97]'}
                    ${isPick ? `ring-4 ring-inset ${t.ring}` : ''}
                    ${locked && !isPick ? 'opacity-40' : ''}`}>
                  <OptionKey>{t.key}</OptionKey>{opt}
                </button>
              )
            })}
          </div>
          {/* never leave live-looking tiles up after the clock runs out, and never
              claim "locked in" for an answer the server has not acknowledged */}
          <p className={`flex-none text-center text-sm font-semibold
            ${pending != null || status !== 'open' ? 'text-peach-ink' : 'text-muted'}`}>
            {pending != null ? 'Still sending — tap again if this stays up'
              : status !== 'open' ? 'Offline — reconnecting…'
                : timeUp ? "Time's up — results coming…"
                  : picked == null ? 'Tap your answer' : 'Locked in — waiting for the others…'}
          </p>
        </>
      )}

      {view.screen === 'results' && (
        <>
          {/* the big slot carries points when there are points, and the verdict
              when there are not. A poll has neither, so it just confirms the tap. */}
          <div className="flex flex-none flex-col items-center gap-1 py-4">
            <div className={`anim-pop text-[clamp(2.6rem,16vw,5rem)] font-extrabold tracking-tight
              ${view.gained > 0 ? 'text-mint-ink' : 'text-muted'}`}>
              {scored ? <>+<Ticker to={view.gained} ms={800} /></>
                : view.correct != null ? (picked === view.correct ? 'Correct' : 'Not this time')
                  : 'Answered'}
            </div>
            <p className="font-semibold text-muted">
              {view.correct != null
                ? <>{(scored ? view.gained > 0 : picked === view.correct) ? 'Correct' : 'Not this time'}
                  {' · '}{view.options[view.correct]}</>
                : picked != null ? <>You picked · {view.options[picked]}</> : 'Answer recorded'}
            </p>
          </div>
          {view.leaderboard?.length > 0 &&
            <Leaderboard rows={view.leaderboard.slice(0, 5)} meName={myName} compact />}
          <p className="flex-none text-center text-sm font-semibold text-muted">
            {view.last ? 'Waiting for the final results…' : 'Waiting for the host to continue…'}
          </p>
          {scored && (
            <div className="flex flex-none items-center justify-between font-semibold text-muted">
              {view.your_rank != null && <span>You're #{view.your_rank}</span>}
              <span className="ml-auto tabular-nums">{view.your_score} pts</span>
            </div>
          )}
        </>
      )}

      {view.screen === 'over' && (
        <>
          <div className="flex flex-none flex-col items-center gap-1 py-4">
            <div className="anim-pop text-[clamp(2.6rem,16vw,5rem)] font-extrabold
              tracking-tight text-anchor">
              {faceOf(myName)}{view.leaderboard && ` #${rankOf(view.leaderboard, myName)}`}
            </div>
            <p className="font-semibold text-muted">
              {view.leaderboard ? `out of ${view.total_players} players`
                : `${view.total_players} took part`}
            </p>
          </div>
          {view.leaderboard?.length > 0 &&
            <Leaderboard rows={view.leaderboard.slice(0, 5)} meName={myName} compact />}
          <p className="flex-none text-center font-semibold text-muted">
            {view.leaderboard ? 'Well played' : 'Thanks for taking part'}
          </p>
        </>
      )}
    </Screen>
  )
}

const rankOf = (lb, name) => {
  const row = (lb || []).find((p) => p.name === name)
  // the server's dense rank, so a tie reads the same here as on the projector
  return row ? row.rank : '—'
}


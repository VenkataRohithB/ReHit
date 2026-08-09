import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { wsUrl } from '../lib/api.js'
import { useSocket } from '../lib/useSocket.js'
import {
  Screen, Button, TimerBar, OptionKey, Leaderboard, QuestionMedia, Ticker, faceOf,
  tone, useCountdown,
} from '../ui.jsx'

export default function Play() {
  const { code } = useParams()
  // survive a refresh: the room remembers the email, so rejoining restores the score
  const SEAT = `quiz.seat.${code}`
  const saved = localStorage.getItem(SEAT) || ''
  const [email, setEmail] = useState(saved)
  const [joined, setJoined] = useState(!!saved)
  const [err, setErr] = useState('')
  const [lobby, setLobby] = useState({ count: 0, capacity: 0 })
  const [view, setView] = useState({ screen: 'lobby' })
  const [picked, setPicked] = useState(null)     // confirmed sent to the server
  const [pending, setPending] = useState(null)   // tapped, but the socket was down

  const onMsg = useCallback((m) => {
    switch (m.type) {
      case 'error':
        setErr(m.msg); setJoined(false); localStorage.removeItem(SEAT); break
      case 'joined': setErr(''); localStorage.setItem(SEAT, m.email); break
      case 'lobby': setLobby(m); break
      case 'question':
        // your_answer is present when we refreshed after already answering
        setPicked(m.your_answer ?? null); setPending(null)
        setView({ screen: 'question', ...m }); break
      case 'results': setView({ screen: 'results', ...m }); break
      case 'game_over': setView({ screen: 'over', ...m }); break
      default: break
    }
  }, [SEAT])

  const url = joined ? wsUrl(`/ws/play/${code}?email=${encodeURIComponent(email)}`) : null
  const { status, send } = useSocket(url, onMsg)
  const isQuestion = view.screen === 'question'
  const reading = isQuestion && view.phase === 'reading'
  // key on the phase as well as the index so the clock restarts at the reveal
  const timeLeft = useCountdown(isQuestion ? view.remaining : null, view.window ?? 0,
    `${view.index}:${view.phase}`)
  const timeUp = isQuestion && !reading && timeLeft <= 0

  const doJoin = (e) => {
    e.preventDefault()
    const em = email.trim().toLowerCase()
    if (!em) { setErr('Enter your email to join'); return }
    setEmail(em)
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
          <h1 className="text-[clamp(1.6rem,8vw,2.4rem)] font-extrabold tracking-tight">Join the quiz</h1>
          <input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@atria.edu" aria-label="Your email"
            className="rounded-2xl border-2 border-line px-5 py-4 text-left text-lg
              outline-none placeholder:text-muted/60 focus:border-anchor" />
          <Button type="submit" className="py-4 text-lg">Join</Button>
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
        {isQuestion && !reading && (
          <span className={`text-2xl font-extrabold tabular-nums
            ${timeLeft <= 5 ? 'text-rose-ink' : 'text-ink'}`}>{Math.ceil(timeLeft)}</span>
        )}
      </div>

      {view.screen === 'lobby' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-[clamp(3rem,18vw,6rem)] font-extrabold tabular-nums text-anchor">
            {lobby.count}
          </div>
          <p className="text-muted">
            {lobby.count === 1 ? 'player is' : 'players are'} in the room
          </p>
          <p className="mt-4 font-semibold">Waiting for the host to start…</p>
          <p className="text-sm text-muted">{email}</p>
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
          <TimerBar remaining={view.remaining} total={view.window} qkey={view.index} />
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
          <div className="flex flex-none flex-col items-center gap-1 py-4">
            <div className={`anim-pop text-[clamp(2.6rem,16vw,5rem)] font-extrabold tracking-tight
              ${view.gained > 0 ? 'text-mint-ink' : 'text-muted'}`}>
              +<Ticker to={view.gained} ms={800} />
            </div>
            <p className="font-semibold text-muted">
              {view.gained > 0 ? 'Correct' : 'Not this time'} · {view.options[view.correct]}
            </p>
          </div>
          <Leaderboard rows={view.leaderboard.slice(0, 5)} meEmail={email} compact />
          <p className="flex-none text-center text-sm font-semibold text-muted">
            {view.last ? 'Waiting for the final results…' : 'Waiting for the host to continue…'}
          </p>
          <div className="flex flex-none items-center justify-between font-semibold text-muted">
            <span>You're #{view.your_rank}</span><span className="tabular-nums">{view.your_score} pts</span>
          </div>
        </>
      )}

      {view.screen === 'over' && (
        <>
          <div className="flex flex-none flex-col items-center gap-1 py-4">
            <div className="anim-pop text-[clamp(2.6rem,16vw,5rem)] font-extrabold
              tracking-tight text-anchor">
              {faceOf(email)} #{rankOf(view.leaderboard, email)}
            </div>
            <p className="font-semibold text-muted">out of {view.total_players} players</p>
          </div>
          <Leaderboard rows={view.leaderboard.slice(0, 5)} meEmail={email} compact />
          <p className="flex-none text-center font-semibold text-muted">Well played</p>
        </>
      )}
    </Screen>
  )
}

const rankOf = (lb, email) => {
  const i = lb.findIndex((p) => p.email === email)
  return i < 0 ? '—' : i + 1
}


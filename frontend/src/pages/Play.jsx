import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { wsUrl, roomInfo } from '../lib/api.js'
import { useSocket } from '../lib/useSocket.js'
import { asList, sameAnswer, answerText } from '../lib/question.js'
import {
  Screen, Button, TimerBar, OptionKey, Leaderboard, QuestionMedia, Ticker, faceOf, clock,
  tone, useCountdown, useStopwatch, Logo, QuizTagline, avgText,
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
  // select-all ticks before Submit. Each change is sent as a draft too, so the
  // ticks still count if the clock runs out before Submit is pressed
  const [ticks, setTicks] = useState([])
  const onIndex = useRef(null)                   // which question the ticks belong to
  const [typedNum, setTypedNum] = useState('')   // a live-average answer, before it is sent
  const [numErr, setNumErr] = useState('')

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
        if (m.state === 'waiting') {
          setView({ screen: 'lobby' }); setPicked(null); setPending(null); setTicks([])
        }
        break
      case 'question':
        // your_answer is present when we refreshed after already answering
        setPicked(m.your_answer ?? null); setPending(null); setNumErr('')
        if (m.phase === 'reading') setTypedNum('')
        // the server's copy wins on a resume; otherwise keep ticks within the
        // same question (reading -> answering) and clear them for a new one
        setTicks((t) => m.your_picks ?? (onIndex.current === m.index ? t : []))
        onIndex.current = m.index
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
  // what this phone answered — ticks that were never submitted still went in
  // when the clock ran out
  const mine = picked ?? (ticks.length ? ticks : null)

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

  const multi = !!view.multi
  const toggle = (i) => {
    if (picked != null || timeUp) return
    const next = ticks.includes(i) ? ticks.filter((x) => x !== i) : [...ticks, i].sort((a, b) => a - b)
    setTicks(next)
    send({ type: 'pick', option: next })   // best effort; resent below after a reconnect
  }
  const submit = () => {
    if (picked != null || !ticks.length) return
    if (send({ type: 'answer', option: ticks })) { setPicked(ticks); setPending(null) }
    else setPending(ticks)
  }

  // Ticks made while the socket was down never reached the server as a draft.
  useEffect(() => {
    if (status !== 'open' || !multi || picked != null || pending != null || !ticks.length) return
    if (isQuestion && !reading) send({ type: 'pick', option: ticks })
  }, [status, multi, picked, pending, isQuestion, reading, view.index])

  // the server enforces the range as well — this only saves a round trip and
  // says what was wrong, since an out-of-range answer is otherwise just ignored
  const submitNumber = (e) => {
    e.preventDefault()
    const [lo, hi] = view.range
    const n = Number(typedNum)
    if (!typedNum.trim() || !Number.isInteger(n) || n < lo || n > hi) {
      setNumErr(`Enter a whole number from ${lo} to ${hi}`)
      return
    }
    setNumErr('')
    answer(n)
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
          {multi && <p className="-mt-1 flex-none font-semibold text-anchor">Select all that apply</p>}
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
          {multi && <p className="-mt-1 flex-none font-semibold text-anchor">Select all that apply</p>}
          <QuestionMedia code={view.code} image={view.image} />
          {view.range ? (
            <form onSubmit={submitNumber} noValidate className="flex flex-1 flex-col justify-center gap-3">
              <input type="number" step="1" min={view.range[0]} max={view.range[1]} autoFocus
                // Android's numeric pad has no minus key
                inputMode={view.range[0] < 0 ? 'text' : 'numeric'}
                value={picked ?? typedNum} disabled={picked != null}
                onChange={(e) => { setTypedNum(e.target.value); setNumErr('') }}
                aria-label={`Your answer, from ${view.range[0]} to ${view.range[1]}`}
                placeholder={`${view.range[0]}–${view.range[1]}`}
                className="w-full rounded-3xl border-2 border-line bg-canvas px-5 py-5 text-center
                  text-[clamp(2rem,12vw,3.5rem)] font-extrabold tabular-nums outline-none
                  placeholder:text-muted/40 focus:border-anchor disabled:bg-track" />
              {numErr
                ? <p role="alert" className="text-center font-semibold text-rose-ink">{numErr}</p>
                : <p className="text-center text-sm text-muted">
                    A whole number from {view.range[0]} to {view.range[1]}
                  </p>}
              {picked == null && <Button type="submit" className="py-4 text-lg">Submit</Button>}
            </form>
          ) : (
          /* bottom of the screen, where the thumb already is — the question keeps
             the top to itself */
          <>
          <div className="flex flex-1 flex-col justify-end gap-3">
            {view.options.map((opt, i) => {
              const t = tone(i)
              // a select-all question shows its ticks; a single one its tap
              const isPick = multi
                ? (picked != null ? asList(picked) : asList(pending ?? ticks)).includes(i)
                : picked === i || pending === i
              // a pending tap does NOT lock — re-tapping is how you retry
              const locked = picked != null || timeUp
              return (
                <button key={i} onClick={() => (multi ? toggle(i) : answer(i))} disabled={locked}
                  aria-pressed={multi ? isPick : undefined}
                  style={{ animationDelay: `${i * 70}ms` }}
                  className={`anim-pop flex min-h-14 items-center gap-3 rounded-3xl px-4 py-4 text-left
                    text-[clamp(1rem,4.4vw,1.3rem)] font-semibold transition
                    ${t.fill} ${t.ink}
                    ${locked ? '' : 'active:scale-[.97]'}
                    ${isPick ? `ring-4 ring-inset ${t.ring}` : ''}
                    ${locked && !isPick ? 'opacity-40' : ''}`}>
                  <OptionKey>{t.key}</OptionKey>{opt}
                  {multi && isPick && <span aria-hidden="true" className="ml-auto font-extrabold">✓</span>}
                </button>
              )
            })}
          </div>
          {multi && picked == null && !timeUp && (
            <Button onClick={submit} disabled={!ticks.length} className="flex-none py-4 text-lg">
              Submit
            </Button>
          )}
          </>
          )}
          {/* never leave live-looking tiles up after the clock runs out, and never
              claim "locked in" for an answer the server has not acknowledged */}
          <p className={`flex-none text-center text-sm font-semibold
            ${pending != null || status !== 'open' ? 'text-peach-ink' : 'text-muted'}`}>
            {pending != null ? 'Still sending — tap again if this stays up'
              : status !== 'open' ? 'Offline — reconnecting…'
                : timeUp ? (multi && picked == null && ticks.length
                  ? "Time's up — your ticks count, results coming…" : "Time's up — results coming…")
                  : picked != null ? 'Locked in — waiting for the others…'
                    : view.range ? 'Type a number and submit'
                      : !multi ? 'Tap your answer'
                        : ticks.length ? 'Press Submit to lock it in' : 'Tick every answer that applies'}
          </p>
        </>
      )}

      {view.screen === 'results' && (() => {
        const graded = view.correct != null
        const right = graded && (scored ? view.gained > 0 : sameAnswer(mine, view.correct))
        const move = view.your_move ?? 0
        return (
          <>
            <div className="flex flex-1 flex-col justify-center gap-4">
              <div className="flex flex-col items-center gap-1">
                {graded && (
                  <span className={`text-lg font-extrabold ${right ? 'text-mint-ink' : 'text-rose-ink'}`}>
                    {right ? 'Correct!' : 'Not this time'}
                  </span>
                )}
                {/* points when there are points, the class average on a live
                    average, and a plain confirmation on a poll */}
                <div className={`anim-pop text-[clamp(2.6rem,18vw,5.5rem)] font-extrabold leading-none
                  tracking-tight tabular-nums ${view.spread ? 'text-ink'
                    : view.gained > 0 ? 'text-mint-ink' : 'text-muted'}`}>
                  {view.spread ? avgText(view.spread.average)
                    : scored ? <>+<Ticker to={view.gained} ms={800} /></>
                      : 'Answered'}
                </div>
                {view.spread && (
                  <p className="font-semibold text-muted">
                    Class average{picked != null && <> · you said {picked}</>}
                  </p>
                )}
              </div>

              {/* the right answer in its own colour, so it matches the projector —
                  one card per option on a select-all question */}
              {graded && asList(view.correct).map((i) => {
                const t = tone(i)
                return (
                  <div key={i} className={`flex items-center gap-3 rounded-3xl px-4 py-4 text-lg
                    font-extrabold ${t.fill} ${t.ink}`}>
                    <OptionKey>{t.key}</OptionKey>
                    <span className="min-w-0 flex-1">{view.options[i]}</span>✓
                  </div>
                )
              })}
              {graded && !right && mine != null && (
                <p className="text-center font-semibold text-muted">
                  You picked · {answerText(view.options, mine)}
                </p>
              )}
              {!graded && !view.spread && (
                <p className="text-center font-semibold text-muted">
                  {mine != null ? <>You picked · {answerText(view.options, mine)}</> : 'Answer recorded'}
                </p>
              )}

              {scored && view.your_rank != null && (
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="rounded-3xl bg-track px-3 py-4">
                    <b className="block text-4xl font-extrabold tabular-nums">#{view.your_rank}</b>
                    <span className="text-sm font-semibold text-muted">of {view.total_players} players</span>
                  </div>
                  <div className="rounded-3xl bg-track px-3 py-4">
                    <b className={`block text-4xl font-extrabold tabular-nums
                      ${move > 0 ? 'text-mint-ink' : move < 0 ? 'text-rose-ink' : 'text-muted'}`}>
                      {move > 0 ? `▲ ${move}` : move < 0 ? `▼ ${-move}` : '–'}
                    </b>
                    <span className="text-sm font-semibold text-muted">
                      {move > 0 ? `place${move === 1 ? '' : 's'} up` : move < 0
                        ? `place${move === -1 ? '' : 's'} down` : 'no change'}
                    </span>
                  </div>
                </div>
              )}
              {view.leaderboard?.length > 0 &&
                <Leaderboard rows={view.leaderboard.slice(0, 5)} meName={myName} compact />}
            </div>
            <p className="flex-none text-center text-sm font-semibold text-muted">
              {scored && <span className="tabular-nums">{view.your_score} pts · </span>}
              {view.last ? 'Waiting for the final results…' : 'Waiting for the host to continue…'}
            </p>
          </>
        )
      })()}

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
            {view.quit ? 'The host ended the quiz' : view.leaderboard ? 'Well played'
              : 'Thanks for taking part'}
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


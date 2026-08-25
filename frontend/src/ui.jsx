import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/* ============================ animation kit ============================
   Everything here is hand-rolled — no animation dependency. See DESIGN.md.
   All of it no-ops under prefers-reduced-motion. */

export const SPRING = 'cubic-bezier(.34,1.56,.64,1)'
export const CALM = 'cubic-bezier(.22,1,.36,1)'
export const still = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const CONFETTI_INK = ['#0B6B52', '#9E4526', '#5B34B0', '#7A5606', '#2B4BC4', '#B03A60']

/** Canvas confetti burst. Returns a stop() that also removes the canvas. */
export function fireConfetti(host, { n = 160, x = 0.5, y = 0.35, power = 1.1 } = {}) {
  if (!host || still()) return () => {}
  const c = document.createElement('canvas')
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:30'
  host.appendChild(c)
  const dpr = Math.min(devicePixelRatio || 1, 2)
  const W = host.clientWidth, H = host.clientHeight
  c.width = W * dpr; c.height = H * dpr
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr)
  const P = Array.from({ length: n }, (_, i) => ({
    x: W * x, y: H * y,
    vx: (Math.random() - 0.5) * 15 * power,
    vy: (Math.random() * -9 - 4) * power,
    w: 5 + Math.random() * 6, h: 4 + Math.random() * 5,
    rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
    col: CONFETTI_INK[i % CONFETTI_INK.length],
  }))
  let raf
  const tick = () => {
    ctx.clearRect(0, 0, W, H)
    let alive = 0
    for (const p of P) {
      p.vy += 0.42; p.vx *= 0.995; p.x += p.vx; p.y += p.vy; p.rot += p.vr
      if (p.y > H + 40) continue
      alive++
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot)
      ctx.fillStyle = p.col; ctx.globalAlpha = 0.95
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore()
    }
    if (alive) raf = requestAnimationFrame(tick); else c.remove()
  }
  tick()
  return () => { cancelAnimationFrame(raf); c.remove() }
}

/** Number that counts up to `to`. Tabular so the digits never jitter. */
export function Ticker({ to, ms = 900, suffix = '', className = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (still()) { el.textContent = to.toLocaleString() + suffix; return }
    const t0 = performance.now()
    let raf
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms)
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString() + suffix
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [to, ms, suffix])
  return <span ref={ref} className={`tabular-nums ${className}`}>0{suffix}</span>
}

/* deterministic avatar + size per player, so a face never changes mid-lobby */
const EMOJI = ['🦊', '🐼', '🦉', '🐙', '🦁', '🐸', '🦄', '🐝', '🐳', '🦋', '🐢', '🦖',
  '🐧', '🦩', '🐰', '🦔', '🐨', '🦜', '🐺', '🐬']
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
export const faceOf = (email) => EMOJI[hash(email) % EMOJI.length]

/** Lobby: pastel capsules that pop in as people join, then breathe in place.
 *
 *  ponytail: laid out by flex-wrap, NOT simulated. The previous version ran a
 *  soft-body physics loop — a pull toward the centre fighting an O(n²) push-apart
 *  pass, four relaxation passes a frame. At 70 players that is ~9,700 pair tests
 *  every frame, and because the two forces pull in opposite directions it never
 *  reaches a resting state: pills jitter, shove each other and swap places
 *  forever. Layout that *cannot* overlap beats physics that *must not*.
 *
 *  Only the most recent RECENT_SHOWN are drawn, newest first. Every joiner
 *  getting a pill meant each arrival re-flowed the whole wall and stepped the
 *  type down, so a full room churned on every join. The headline count above
 *  is the real number; these are the last few faces through the door.
 *
 *  Everything varying per person (hue, float speed, phase) is derived from a hash
 *  of the email, so a face and its rhythm never change mid-lobby. */
const RECENT_SHOWN = 30

export function LobbyPills({ players }) {
  const shown = players.slice(-RECENT_SHOWN).reverse()   // newest through the door first
  const hidden = players.length - shown.length
  const size = shown.length > 12 ? '.9rem' : '1.15rem'
  return (
    <div className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center
      gap-[clamp(.3rem,.75vw,.65rem)] overflow-hidden p-2">
      {hidden > 0 && (
        <span style={{ fontSize: size }}
          className="flex items-center rounded-full bg-ink/5 px-3 py-1.5 font-bold
            leading-none text-muted tabular-nums">
          +{hidden} more
        </span>
      )}
      {shown.map((email) => {
        const h = hash(email)
        const t = TONES[h % TONES.length]
        return (
          <span key={email} style={{
            fontSize: size,
            '--bob': `${3.2 + (h >> 5) % 26 / 10}s`,      // 3.2s–5.7s
            '--bob-delay': `-${(h >> 11) % 40 / 10}s`,    // negative: already mid-cycle
          }}
            className={`anim-join flex items-center gap-1.5 whitespace-nowrap rounded-full
              px-3 py-1.5 font-bold leading-none ${t.fill} ${t.ink}`}>
            <span style={{ fontSize: '1.45em' }}>{faceOf(email)}</span>
            {email.split('@')[0]}
          </span>
        )
      })}
    </div>
  )
}

/* Categorical option palette — see DESIGN.md. Index N is the same hue on the
   phone, the host screen, the result bars and the podium. Never reorder. */
export const TONES = [
  { fill: 'bg-mint',   ink: 'text-mint-ink',   ring: 'ring-mint-ink',   key: 'A' },
  { fill: 'bg-peach',  ink: 'text-peach-ink',  ring: 'ring-peach-ink',  key: 'B' },
  { fill: 'bg-lilac',  ink: 'text-lilac-ink',  ring: 'ring-lilac-ink',  key: 'C' },
  { fill: 'bg-butter', ink: 'text-butter-ink', ring: 'ring-butter-ink', key: 'D' },
  { fill: 'bg-peri',   ink: 'text-peri-ink',   ring: 'ring-peri-ink',   key: 'E' },
  { fill: 'bg-rose',   ink: 'text-rose-ink',   ring: 'ring-rose-ink',   key: 'F' },
]
export const tone = (i) => TONES[i % TONES.length]

/* rank 1-3 medals, then neutral track */
const RANKS = ['bg-butter text-butter-ink', 'bg-peri text-peri-ink', 'bg-peach text-peach-ink']
const RANK_PILL = ['bg-butter-ink text-butter', 'bg-peri-ink text-peri', 'bg-peach-ink text-peach']
/* racing-bar fill: podium keeps its hue, everyone else gets one neutral tint */
const RANK_FILL = ['bg-butter-ink/20', 'bg-peri-ink/20', 'bg-peach-ink/20']

export function Screen({ children, className = '' }) {
  return (
    <div className={`flex h-full flex-col gap-[clamp(.9rem,2vw,1.8rem)]
      p-[clamp(1rem,3vw,3rem)] ${className}`}>{children}</div>
  )
}

export function JoinStrip({ code, right, host = location.host }) {
  return (
    <div className="flex flex-none items-center gap-3 rounded-2xl border border-line
      px-[clamp(.8rem,1.6vw,1.4rem)] py-[clamp(.5rem,1vw,.9rem)]
      text-[clamp(.75rem,1.35vw,1.05rem)] font-medium text-muted">
      <span>Join at</span>
      <span className="font-extrabold text-ink">{host}</span>
      <span aria-hidden="true">·</span>
      <span className="rounded-lg bg-anchor-tint px-2.5 py-0.5 font-extrabold
        tracking-[.1em] text-anchor">{code}</span>
      <span className="flex-1" />
      <span className="font-semibold tabular-nums">{right}</span>
    </div>
  )
}

export function Button({ children, className = '', ...props }) {
  return (
    <button className={`rounded-xl bg-anchor px-6 py-3.5 font-extrabold text-white
      transition hover:brightness-110 active:scale-[.98]
      disabled:opacity-40 disabled:hover:brightness-100 ${className}`} {...props}>
      {children}
    </button>
  )
}

/* The server sends how many seconds are LEFT, not an absolute stamp, and we count
   down from our own clock. Comparing a server timestamp against Date.now() broke
   on any device whose clock was off — a phone a few seconds fast would hit zero
   early and then just sit there. Only local deltas are used here, so skew cannot
   affect it. `key` restarts the countdown on each new question. */
export function useCountdown(remaining, total, key) {
  const [left, setLeft] = useState(remaining ?? total)
  useEffect(() => {
    if (remaining == null) { setLeft(total); return }
    const start = Date.now()
    const tick = () => setLeft(Math.max(0, remaining - (Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 100)
    return () => clearInterval(id)
  }, [remaining, total, key])
  return left
}

/* Phone timer: the ring's urgency language on a bar, which costs less of the
   vertical space the answer tiles need. Blue → amber → rose, then a shimmer. */
export function TimerBar({ remaining, total, qkey }) {
  const left = useCountdown(remaining, total, qkey)
  const frac = total ? Math.max(0, Math.min(1, left / total)) : 1
  const colour = left <= 5 ? 'bg-danger' : left <= 8 ? 'bg-warn' : 'bg-anchor'
  return (
    <div className="relative h-2 flex-none overflow-hidden rounded-full bg-track">
      <div className={`h-full rounded-full transition-[transform,background-color] duration-100
        ease-linear ${colour}`}
        style={{ transform: `scaleX(${frac})`, transformOrigin: 'left center' }} />
      {left > 0 && !still() && (
        <div className="pointer-events-none absolute inset-y-0 w-1/3 animate-[shimmer_1.6s_linear_infinite]
          bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      )}
    </div>
  )
}

/* Optional snippet / illustration that sits between the question and the options.
   The snippet scrolls inside its own box so a long paste can never push the
   options off a projected screen. */
export function QuestionMedia({ code, image, className = '' }) {
  if (!code && !image) return null
  return (
    <div className={`flex min-h-0 flex-none flex-col gap-2 ${className}`}>
      {code && (
        <pre className="max-h-[34vh] overflow-auto rounded-2xl bg-track p-[clamp(.6rem,1.4vw,1.2rem)]
          text-left font-mono text-[clamp(.7rem,1.35vw,1.15rem)] leading-relaxed text-ink">
          <code>{code}</code>
        </pre>
      )}
      {image && (
        <img src={image} alt="" loading="lazy"
          className="max-h-[30vh] self-center rounded-2xl object-contain" />
      )}
    </div>
  )
}

export function OptionKey({ children, className = '' }) {
  return (
    <span className={`grid aspect-square w-[2.1em] flex-none place-items-center rounded-full
      bg-white/70 text-[.7em] font-extrabold ${className}`}>{children}</span>
  )
}

/** Countdown ring — sweeps down, shifts blue → amber → rose, breathes under 5s. */
export function TimerRing({ remaining, total, qkey, className = '' }) {
  const left = useCountdown(remaining, total, qkey)
  const frac = total ? Math.max(0, Math.min(1, left / total)) : 1
  const C = 2 * Math.PI * 52
  const urgent = left <= 5
  const colour = urgent ? 'var(--color-danger)'
    : left <= 8 ? 'var(--color-warn)' : 'var(--color-anchor)'
  return (
    <svg viewBox="0 0 120 120" className={`mx-auto ${className}`} aria-hidden="true"
      style={urgent && !still() ? { animation: 'breathe .9s ease-in-out infinite' } : undefined}>
      <circle cx="60" cy="60" r="52" fill="none" stroke="var(--color-track)" strokeWidth="11" />
      <circle cx="60" cy="60" r="52" fill="none" stroke={colour} strokeWidth="11"
        strokeLinecap="round" transform="rotate(-90 60 60)"
        strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
        style={{ transition: 'stroke-dashoffset .1s linear, stroke .3s' }} />
      <text x="60" y="73" textAnchor="middle" fontSize="36" fontWeight="800" fill="currentColor"
        className="tabular-nums">{Math.ceil(left)}</text>
    </svg>
  )
}

/* Result bars — race out with counting percentages, then everything except the
   correct answer greys out so the answer is the only thing left with colour. */
export function ResultBars({ tally, options, correct, settleMs = 1500 }) {
  const total = tally.reduce((a, b) => a + b, 0) || 1
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    setSettled(false)
    const t = setTimeout(() => setSettled(true), still() ? 0 : settleMs)
    return () => clearTimeout(t)
  }, [tally, settleMs])

  return (
    <div className="flex flex-1 flex-col justify-center gap-[clamp(.5rem,1.2vw,1.1rem)]">
      {options.map((opt, i) => {
        const t = tone(i)
        const pct = Math.round((tally[i] / total) * 100)
        const right = i === correct
        const dim = settled && !right
        return (
          <div key={i}
            className={`relative flex items-center overflow-hidden rounded-2xl bg-track
              px-[clamp(.7rem,1.5vw,1.3rem)] py-[clamp(.6rem,1.3vw,1.2rem)]
              text-[clamp(.85rem,1.7vw,1.5rem)] font-semibold transition-all duration-500 ${t.ink}
              ${right && settled ? `ring-2 ring-inset ${t.ring} scale-[1.015]` : ''}
              ${dim ? 'opacity-55 grayscale-[.7]' : ''}`}>
            <div className={`absolute inset-y-0 left-0 rounded-2xl ${t.fill}`}
              style={{
                width: `${pct}%`,
                transition: still() ? 'none' : `width .85s ${CALM} ${i * 0.12}s`,
              }} />
            <span className="relative z-10 flex flex-1 items-center gap-3">
              <OptionKey>{t.key}</OptionKey>{opt}
              {right && settled && <span aria-label="correct answer">✓</span>}
            </span>
            <span className="relative z-10 font-extrabold">
              <Ticker to={pct} ms={850} suffix="%" />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* relative + z-10 so the racing bar fill behind it cannot paint over the arrow */
function Arrow({ d }) {
  if (!d) return (
    <span className="relative z-10 w-8 flex-none text-right text-[.7em] font-bold text-muted/50">–</span>
  )
  const up = d > 0
  return (
    <span className={`relative z-10 w-8 flex-none text-right text-[.7em] font-bold
      ${up ? 'text-mint-ink' : 'text-rose-ink'}`}>
      {up ? '▲' : '▼'}{Math.abs(d)}
    </span>
  )
}

function Row({ p, i, me, compact, refFn }) {
  const medal = i < 3 ? RANKS[i] : 'bg-track'
  const pill = i < 3 ? RANK_PILL[i] : 'bg-white text-muted'
  const moved = !!p.delta
  return (
    <div ref={refFn}
      className={`flex items-center gap-3 rounded-xl ${medal} ${moved ? '' : 'anim-slidein'}
      ${compact ? 'px-3 py-2 text-[clamp(.8rem,3vw,1rem)]' : 'px-3 py-[.45rem] text-[clamp(.7rem,1.15vw,1rem)]'}
      ${me ? 'ring-2 ring-inset ring-anchor' : ''}`}
      style={moved ? undefined : { animationDelay: `${i * 28}ms` }}>
      <span className={`grid aspect-square w-[1.9em] flex-none place-items-center rounded-full
        text-[.78em] font-extrabold tabular-nums ${pill}`}>{i + 1}</span>
      <span className="flex-1 truncate font-semibold">{p.email}</span>
      {!compact && <Arrow d={p.delta} />}
      <span className="min-w-[3.4em] text-right text-[1.05em] font-extrabold tabular-nums">{p.score}</span>
    </div>
  )
}

/* Animated overtakes. The board remounts between rounds, so there are no previous
   DOM positions to diff — instead each mover starts at where its OLD rank sat
   (delta rows away) and slides to its new one, which is the same thing on screen.
   ponytail: vertical approximation; a row crossing between the two columns
   travels the right distance but not the right path. Swap for a persistent
   FLIP + shared layout if that ever reads wrong. */
function useOvertakes(rows) {
  const refs = useRef(new Map())
  useLayoutEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const first = refs.current.values().next().value
    if (!first) return
    const pitch = first.offsetHeight + 6            // row height + gap-1.5
    for (const p of rows) {
      const el = refs.current.get(p.email)
      if (!el || !p.delta) continue
      el.animate(
        [{ transform: `translateY(${p.delta * pitch}px)`, opacity: 0.55 },
         { transform: 'none', opacity: 1 }],
        { duration: 620, delay: 140, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' },
      )
    }
  }, [rows])
  return (email) => (el) => { el ? refs.current.set(email, el) : refs.current.delete(email) }
}

/* Top 15 in two columns — a projected board that scrolls is a broken board. */
export function Leaderboard({ rows, meEmail, compact = false }) {
  const bind = useOvertakes(rows || [])
  if (!rows?.length) return <p className="text-center text-muted">No scores yet.</p>
  if (compact) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-2">
        {rows.map((p, i) => (
          <Row key={p.email} p={p} i={i} me={p.email === meEmail} compact refFn={bind(p.email)} />
        ))}
      </div>
    )
  }
  const half = Math.ceil(rows.length / 2)
  const col = (slice, offset) => (
    <div className="flex flex-col gap-1.5">
      {slice.map((p, i) => (
        <Row key={p.email} p={p} i={i + offset} me={p.email === meEmail} refFn={bind(p.email)} />
      ))}
    </div>
  )
  return (
    <div className="grid flex-1 grid-cols-1 content-start gap-x-6 gap-y-2 sm:grid-cols-2">
      {col(rows.slice(0, half), 0)}
      {col(rows.slice(half), half)}
    </div>
  )
}

/* Leaderboard that races, then overtakes.
   Rows first appear in their PREVIOUS order (recovered from each row's delta) and
   race out as bars; then they travel to their new positions with a FLIP. One set
   of elements does both, which is what makes the movement readable. */
export function RaceBoard({ rows, meEmail, raceMs = 1900 }) {
  const prevOrder = (list) =>
    list.map((r, i) => ({ r, was: i + (r.delta || 0) }))
      .sort((a, b) => a.was - b.was).map((x) => x.r)

  const [order, setOrder] = useState(() => (still() ? rows : prevOrder(rows)))
  const els = useRef(new Map())
  const tops = useRef(new Map())

  useEffect(() => {
    setOrder(still() ? rows : prevOrder(rows))
    if (still()) return
    const t = setTimeout(() => setOrder(rows), raceMs)
    return () => clearTimeout(t)
  }, [rows, raceMs])

  useLayoutEffect(() => {                       // FLIP: invert the delta, play to zero
    if (still()) return
    els.current.forEach((el, key) => {
      const top = el.getBoundingClientRect().top
      const was = tops.current.get(key)
      if (was != null && Math.abs(was - top) > 1) {
        el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }],
          { duration: 760, easing: SPRING })
      }
      tops.current.set(key, top)
    })
  })

  const max = Math.max(...rows.map((r) => r.score), 1)
  const rankOf = new Map(rows.map((r, i) => [r.email, i]))

  const row = (p) => {
    const i = rankOf.get(p.email)
    const medal = i < 3 ? RANKS[i] : 'bg-track'
    const pill = i < 3 ? RANK_PILL[i] : 'bg-white text-muted'
    /* only the podium is tinted — giving every row its own hue turned the board
       into a rainbow and made the medal colours meaningless */
    const fill = i < 3 ? RANK_FILL[i] : 'bg-ink/[.07]'
    return (
      <div key={p.email} ref={(el) => el ? els.current.set(p.email, el) : els.current.delete(p.email)}
        className={`relative flex items-center gap-3 overflow-hidden rounded-xl ${medal}
          px-3 py-[.4rem] text-[clamp(.7rem,1.05vw,.95rem)]
          ${p.email === meEmail ? 'ring-2 ring-inset ring-anchor' : ''}`}>
        <div className={`absolute inset-y-0 left-0 ${fill}`}
          style={{
            width: `${(p.score / max) * 100}%`,
            transition: still() ? 'none' : `width .9s ${CALM}`,
          }} />
        <span className={`relative z-10 grid aspect-square w-[1.9em] flex-none place-items-center
          rounded-full text-[.78em] font-extrabold tabular-nums ${pill}`}>{i + 1}</span>
        <span className="relative z-10 flex-1 truncate font-semibold">{p.email}</span>
        <Arrow d={p.delta} />
        <span className="relative z-10 min-w-[3.2em] text-right text-[1.05em] font-extrabold">
          <Ticker to={p.score} ms={900} />
        </span>
      </div>
    )
  }

  /* two columns — 15 rows stacked pushes the host's Next button off a projector */
  const half = Math.ceil(order.length / 2)
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 content-center gap-x-6 gap-y-1.5 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">{order.slice(0, half).map(row)}</div>
      <div className="flex flex-col gap-1.5">{order.slice(half).map(row)}</div>
    </div>
  )
}

/* The finale: 3rd, 2nd, then a held beat before 1st lands with confetti — and
   then the podium settles in underneath, deliberately without a second burst. */
export function WinnerFinale({ rows, totalPlayers, stepMs = 1800 }) {
  const host = useRef(null)
  const top3 = rows.slice(0, 3)
  const [step, setStep] = useState(still() ? 3 : -1)

  useEffect(() => {
    if (still()) return
    const timers = top3.map((_, k) => setTimeout(() => setStep(k), 400 + k * stepMs))
    timers.push(setTimeout(() => setStep(3), 400 + top3.length * stepMs + 500))
    return () => timers.forEach(clearTimeout)
  }, [rows, stepMs, top3.length])

  useEffect(() => {                       // confetti only on first place
    if (step === top3.length - 1) return fireConfetti(host.current, { n: 170, y: 0.35, power: 1.15 })
  }, [step, top3.length])

  const LABEL = ['1st place', '2nd place', '3rd place']
  const idx = step >= 0 && step < 3 ? top3.length - 1 - step : null   // reveal 3rd → 1st
  const w = idx != null ? top3[idx] : null

  return (
    <div ref={host} className="relative flex min-h-0 flex-1 flex-col">
      {step < 3 ? (
        <div key={step} className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          {w && (
            <>
              <div className={`anim-pop text-[clamp(1.6rem,4.6vw,4rem)] font-extrabold
                tracking-tight ${tone(idx).ink}`}>{LABEL[idx]}</div>
              <div className="anim-floatin flex items-center gap-4">
                <span className={`grid aspect-square w-[clamp(3rem,7vw,6rem)] place-items-center
                  rounded-full text-[clamp(1.5rem,3.4vw,3rem)] ${tone(idx).fill}`}>
                  {faceOf(w.email)}
                </span>
                <span className="text-[clamp(1.4rem,3.6vw,3rem)] font-extrabold">
                  {w.email.split('@')[0]}
                </span>
              </div>
              <div className={`text-[clamp(1.1rem,2.4vw,2rem)] font-extrabold ${tone(idx).ink}`}>
                <Ticker to={w.score} ms={700} />
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-none items-baseline justify-center gap-3">
            <h2 className="text-[clamp(1.1rem,2.4vw,2rem)] font-extrabold tracking-tight">
              Final results
            </h2>
            <span className="font-semibold text-muted">{totalPlayers} players</span>
          </div>
          <Podium rows={rows} />
        </>
      )}
    </div>
  )
}

const POD = [
  { i: 1, h: 'h-[12.5vh]', fill: 'bg-peri',   ink: 'text-peri-ink',   delay: 80 },
  { i: 0, h: 'h-[17vh]',   fill: 'bg-butter', ink: 'text-butter-ink', delay: 240 },
  { i: 2, h: 'h-[9.5vh]',  fill: 'bg-peach',  ink: 'text-peach-ink',  delay: 400 },
]

export function Podium({ rows }) {
  return (
    <div className="flex flex-1 items-end justify-center gap-[clamp(.6rem,2vw,2rem)]">
      {POD.map(({ i, h, fill, ink, delay }) => {
        const p = rows[i]
        if (!p) return <div key={i} className="w-[20%] max-w-48" />
        return (
          <div key={i} className="relative flex w-[20%] max-w-48 flex-col items-center gap-2">
            {i === 0 && (
              <div className="anim-rise absolute -top-[clamp(1.4rem,3vw,2.6rem)]
                text-[clamp(1.2rem,2.8vw,2.4rem)]"
                style={{ animationDelay: '540ms' }}>👑</div>
            )}
            <div className={`grid aspect-square w-[clamp(2.2rem,5vw,4.4rem)] place-items-center
              rounded-full text-[clamp(1.1rem,2.6vw,2.2rem)] ${fill}`}>
              {faceOf(p.email)}
            </div>
            <div className="max-w-full truncate text-[clamp(.65rem,1.2vw,1.1rem)] text-muted">{p.email}</div>
            <div className="text-[clamp(1rem,2vw,2rem)] font-extrabold tabular-nums">{p.score}</div>
            <div className={`anim-rise grid w-full place-items-center rounded-t-2xl
              text-[clamp(1.1rem,2.2vw,2.2rem)] font-extrabold ${h} ${fill} ${ink}`}
              style={{ animationDelay: `${delay}ms` }}>{i + 1}</div>
          </div>
        )
      })}
    </div>
  )
}

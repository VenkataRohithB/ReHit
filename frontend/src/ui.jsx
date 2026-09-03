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
    // a payload that omits the number (an unscored quiz) must not crash the page,
    // and this branch only runs under prefers-reduced-motion — so a raw `to` would
    // throw for exactly the people least able to work around it
    const n = Number(to) || 0
    if (still()) { el.textContent = n.toLocaleString() + suffix; return }
    const t0 = performance.now()
    let raf
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms)
      el.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))).toLocaleString() + suffix
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
export const faceOf = (name) => EMOJI[hash(name) % EMOJI.length]

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
 *  of their name, so a face and its rhythm never change mid-lobby. */
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
      {shown.map((name) => {
        const h = hash(name)
        const t = TONES[h % TONES.length]
        return (
          <span key={name} style={{
            fontSize: size,
            '--bob': `${3.2 + (h >> 5) % 26 / 10}s`,      // 3.2s–5.7s
            '--bob-delay': `-${(h >> 11) % 40 / 10}s`,    // negative: already mid-cycle
          }}
            className={`anim-join flex items-center gap-1.5 whitespace-nowrap rounded-full
              px-3 py-1.5 font-bold leading-none ${t.fill} ${t.ink}`}>
            <span style={{ fontSize: '1.45em' }}>{faceOf(name)}</span>
            {name.split('@')[0]}
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


/** Loading indicator: the dart-throw, in 3D. Same geometry as the logo mark,
    so it settles into the brand rather than into a spinner. `size` is px. */
export function DartLoader({ size = 132, label = 'Loading', className = '' }) {
  return (
    <div role="status" aria-label={label} className={`dl ${className}`}
      style={{ '--dl': `${size}px` }}>
      <div className="dl-scene">
        <svg viewBox="0 0 120 120" className="dl-layer" aria-hidden="true">
          <circle cx="60" cy="60" r="42" fill="none" stroke="var(--color-line)" strokeWidth="9" />
          <circle cx="60" cy="60" r="24" fill="none" stroke="var(--color-peri)" strokeWidth="9" />
        </svg>
        <span className="dl-ripple" />
        <svg viewBox="0 0 120 120" className="dl-layer dl-dart" aria-hidden="true">
          <path d="M 60 60 L 97 23" fill="none" stroke="var(--color-ink)"
            strokeWidth="7" strokeLinecap="round" />
          <polygon points="105.4,14.6 103.2,25.2 92.6,27.4 94.8,16.8" fill="var(--color-lilac)"
            stroke="var(--color-lilac-ink)" strokeWidth="3" strokeLinejoin="round" />
        </svg>
        <svg viewBox="0 0 120 120" className="dl-layer" aria-hidden="true">
          <circle cx="60" cy="60" r="9" fill="var(--color-anchor)" />
        </svg>
      </div>
    </div>
  )
}

/** The ReHit lockup — dart-in-target mark, then "Re" in anchor and "Hit" in
    ink with the dot of the i swapped for an anchor hit-point. The mark here is
    the display version: thin pastel rings, which read at header size but would
    vanish at 16px — favicon.svg is the heavier small-size sibling. Built as dotless ı plus a positioned dot; the em
    offsets are exact glyph metrics from the 800 weight (tittle centre x .13em,
    dot centre y .685em, ø .2em), so it stays true at every font size. */
export function Logo({ className = '' }) {
  return (
    <span aria-label="ReHit"
      className={`logo-lk inline-flex items-baseline font-extrabold tracking-[-0.015em] ${className}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true"
        className="lg-mark mr-[0.3em] h-[1.1em] w-[1.1em] self-center overflow-visible">
        <circle cx="60" cy="60" r="42" fill="none" stroke="var(--color-line)" strokeWidth="9" />
        <circle cx="60" cy="60" r="24" fill="none" stroke="var(--color-peri)" strokeWidth="9" />
        <g className="lg-dart">
          <path d="M 60 60 L 97 23" fill="none" stroke="var(--color-ink)"
            strokeWidth="7" strokeLinecap="round" />
          <polygon points="105.4,14.6 103.2,25.2 92.6,27.4 94.8,16.8" fill="var(--color-lilac)"
            stroke="var(--color-lilac-ink)" strokeWidth="3" strokeLinejoin="round" />
        </g>
        <circle cx="60" cy="60" r="9" fill="var(--color-anchor)" />
      </svg>
      <span aria-hidden="true" className="lg-re text-anchor">Re</span>
      <span aria-hidden="true" className="lg-hit tracking-normal">
        H<span className="lg-dot mr-[-0.23em] inline-block h-[0.2em] w-[0.2em]
          [transform:translateY(-0.585em)] rounded-full bg-anchor align-baseline" />ıt
      </span>
    </span>
  )
}

/** The tagline as quiet chips — Recall / Hit / Repeat with option-tile chips
    for separators (Q3 from the wordmark exploration). Login page only. */
export function QuizTagline({ className = '' }) {
  const word = 'text-[0.7rem] font-semibold uppercase tracking-[.28em] text-muted'
  const chip = 'h-[6px] w-[6px] rounded-[2px]'
  return (
    <div className={`lg-tag flex items-center gap-3 ${className}`}>
      <span className={word}>Recall</span>
      <span className={`${chip} bg-mint`} />
      <span className={word}>Hit</span>
      <span className={`${chip} bg-lilac`} />
      <span className={word}>Repeat</span>
    </div>
  )
}

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
      {/* the strip is the only chrome on a projected screen, so the mark rides
          here rather than on each phase — present all game, never competing
          with the question */}
      <Logo className="text-[1.35em]" />
      <span aria-hidden="true" className="text-line">|</span>
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
/** The question clock is the server's, and every device must show the same
 *  number no matter what its network or its browser did in between.
 *
 *  So: anchor a deadline once from the server's `remaining` and render the gap
 *  to it. A phone that locks, backgrounds, or drops wifi has its timers
 *  throttled or frozen by the browser — but wall-clock arithmetic against a
 *  fixed deadline is still right when it wakes up, where a per-tick decrement
 *  would have silently fallen behind and then had to race to catch up. That
 *  race is what looked like the clock running fast; it never was. */
export function useCountdown(remaining, total, key) {
  const [left, setLeft] = useState(remaining ?? total)
  useEffect(() => {
    if (remaining == null) { setLeft(total); return }
    const ends = Date.now() + remaining * 1000
    const tick = () => setLeft(Math.max(0, (ends - Date.now()) / 1000))
    tick()
    const id = setInterval(tick, 100)
    // a throttled tab can be many seconds stale; resync the instant it is looked
    // at again rather than waiting on the next interval that may never come
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [remaining, total, key])
  return left
}

/** Count-UP for a host-closed question, which has no deadline to count down to.
 *
 *  Anchors the start and renders the gap forward — the same wall-clock trick as
 *  useCountdown, so a phone that locked or backgrounded wakes showing the truth
 *  instead of a stale tick count. Whole seconds, so 250ms is plenty.
 *
 *  A sibling rather than a mode on useCountdown: that one is load-bearing and
 *  carries hard-won behaviour, and one hook serving both directions would be an
 *  abstraction over two things that only look alike. */
export function useStopwatch(elapsed, key) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (elapsed == null) { setSecs(0); return }
    const began = Date.now() - elapsed * 1000
    const tick = () => setSecs(Math.max(0, (Date.now() - began) / 1000))
    tick()
    const id = setInterval(tick, 250)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [elapsed, key])
  return secs
}

/** m:ss for a stopwatch that may run for a while. */
export const clock = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/* Phone timer: the ring's urgency language on a bar, which costs less of the
   vertical space the answer tiles need. Blue → amber → rose, then a shimmer. */
export function TimerBar({ remaining, total, qkey }) {
  const left = useCountdown(remaining, total, qkey)
  const frac = total ? Math.max(0, Math.min(1, left / total)) : 1
  const colour = left <= 5 ? 'bg-danger' : left <= 8 ? 'bg-warn' : 'bg-anchor'
  // A correction bigger than a tick means the tab was frozen and we are catching
  // up. Animating that slides the bar across the screen and reads as the clock
  // sprinting; jump straight to the truth instead.
  const prev = useRef(left)
  const caughtUp = Math.abs(prev.current - left) > 1
  prev.current = left
  return (
    <div className="relative h-2 flex-none overflow-hidden rounded-full bg-track">
      <div className={`h-full rounded-full ${caughtUp ? '' : `transition-[transform,background-color]
        duration-100 ease-linear`} ${colour}`}
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
        // a poll has no answer key: nothing is right, so nothing dims and the bars
        // stay in full colour showing the distribution, which is the whole point
        const right = correct != null && i === correct
        const dim = settled && correct != null && !right
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

/* Live poll columns — options across the X axis, responses up the Y.
   A projected poll that the room answers in real time, so the shape has to read
   from the back of a lecture hall: one column per option, growing upward as the
   taps land.

   Heights scale to the tallest column, not the total. Scaling to the total means
   the first few votes are slivers a metre wide and nothing appears to happen —
   the room needs to see movement on vote three, not vote thirty.

   Deliberately host-only. There is no player equivalent and there should not be:
   a phone showing the running count lets a late answerer follow the crowd. */
export function PollColumns({ tally, options }) {
  const peak = Math.max(1, ...tally)
  const votes = tally.reduce((a, b) => a + b, 0)
  return (
    <div className="flex min-h-0 flex-1 items-stretch justify-center
      gap-[clamp(.4rem,1.6vw,1.5rem)] px-[clamp(0rem,2vw,2rem)]">
      {options.map((opt, i) => {
        const t = tone(i)
        const n = tally[i]
        // a share of the tallest column, floored so an option nobody picked
        // still shows a base to read its letter against
        const h = `${Math.max(2, (n / peak) * 100)}%`
        const pct = votes ? Math.round((n / votes) * 100) : 0
        return (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col
            gap-[clamp(.2rem,.7vh,.55rem)]">
            {/* The count gets its own fixed row at the top. Every column's number
                then sits on one line — easier to compare across a projector than
                numbers floating at different heights — and nothing the bar does
                below can move it. */}
            <span className={`flex-none text-center font-extrabold tabular-nums
              text-[clamp(.9rem,3.4vh,2.4rem)] ${n ? t.ink : 'text-muted/40'}`}>
              <Ticker to={n} ms={420} />
            </span>
            {/* The plot area. The bar is absolutely positioned inside it, so its
                height is purely visual: at 100% it fills this box and stops.
                As a flex sibling it grew past the column instead and printed
                straight over the question above. */}
            <div className="relative min-h-0 flex-1">
              <div className={`absolute inset-x-0 bottom-0 rounded-t-2xl ${t.fill}`}
                style={{ height: h, transition: still() ? 'none' : `height .55s ${CALM}` }} />
            </div>
            <span className="flex flex-none items-center justify-center gap-1.5
              text-center font-semibold text-[clamp(.6rem,1.8vh,1.05rem)]">
              <OptionKey className={t.ink}>{t.key}</OptionKey>
              <span className="min-w-0 truncate">{opt}</span>
            </span>
            <span className="flex-none text-center font-semibold tabular-nums text-muted
              text-[clamp(.55rem,1.4vh,.85rem)]">{pct}%</span>
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
  // the server sends a dense rank — tied scores share it — so the medal and the
  // number come from that, while the stagger stays keyed to screen position
  const r = (p.rank ?? i + 1) - 1
  const medal = r < 3 ? RANKS[r] : 'bg-track'
  const pill = r < 3 ? RANK_PILL[r] : 'bg-white text-muted'
  const moved = !!p.delta
  return (
    <div ref={refFn}
      className={`flex items-center gap-3 rounded-xl ${medal} ${moved ? '' : 'anim-slidein'}
      ${compact ? 'px-3 py-2 text-[clamp(.8rem,3vw,1rem)]' : 'px-3 py-[.45rem] text-[clamp(.7rem,1.15vw,1rem)]'}
      ${me ? 'ring-2 ring-inset ring-anchor' : ''}`}
      style={moved ? undefined : { animationDelay: `${i * 28}ms` }}>
      <span className={`grid aspect-square w-[1.9em] flex-none place-items-center rounded-full
        text-[.78em] font-extrabold tabular-nums ${pill}`}>{r + 1}</span>
      <span className="flex-1 truncate font-semibold">{p.name}</span>
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
      const el = refs.current.get(p.name)
      if (!el || !p.delta) continue
      el.animate(
        [{ transform: `translateY(${p.delta * pitch}px)`, opacity: 0.55 },
         { transform: 'none', opacity: 1 }],
        { duration: 620, delay: 140, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' },
      )
    }
  }, [rows])
  return (name) => (el) => { el ? refs.current.set(name, el) : refs.current.delete(name) }
}

/* Top 15 in two columns — a projected board that scrolls is a broken board. */
export function Leaderboard({ rows, meName, compact = false }) {
  const bind = useOvertakes(rows || [])
  if (!rows?.length) return <p className="text-center text-muted">No scores yet.</p>
  if (compact) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-2">
        {rows.map((p, i) => (
          <Row key={p.name} p={p} i={i} me={p.name === meName} compact refFn={bind(p.name)} />
        ))}
      </div>
    )
  }
  const half = Math.ceil(rows.length / 2)
  const col = (slice, offset) => (
    <div className="flex flex-col gap-1.5">
      {slice.map((p, i) => (
        <Row key={p.name} p={p} i={i + offset} me={p.name === meName} refFn={bind(p.name)} />
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
export function RaceBoard({ rows, meName, raceMs = 1900 }) {
  // recover the previous order from each row's rank and its delta. Must use the
  // rank, not the array index — with ties they are no longer the same number.
  const prevOrder = (list) =>
    list.map((r, i) => ({ r, was: (r.rank ?? i + 1) - 1 + (r.delta || 0) }))
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
  const rankOf = new Map(rows.map((r, i) => [r.name, (r.rank ?? i + 1) - 1]))

  const row = (p) => {
    const i = rankOf.get(p.name)
    const medal = i < 3 ? RANKS[i] : 'bg-track'
    const pill = i < 3 ? RANK_PILL[i] : 'bg-white text-muted'
    /* only the podium is tinted — giving every row its own hue turned the board
       into a rainbow and made the medal colours meaningless */
    const fill = i < 3 ? RANK_FILL[i] : 'bg-ink/[.07]'
    return (
      <div key={p.name} ref={(el) => el ? els.current.set(p.name, el) : els.current.delete(p.name)}
        className={`relative flex items-center gap-3 overflow-hidden rounded-xl ${medal}
          px-3 py-[clamp(.15rem,.5vh,.45rem)] text-[clamp(.7rem,2vh,1.25rem)]
          ${p.name === meName ? 'ring-2 ring-inset ring-anchor' : ''}`}>
        <div className={`absolute inset-y-0 left-0 ${fill}`}
          style={{
            width: `${(p.score / max) * 100}%`,
            transition: still() ? 'none' : `width .9s ${CALM}`,
          }} />
        <span className={`relative z-10 grid aspect-square w-[1.9em] flex-none place-items-center
          rounded-full text-[.78em] font-extrabold tabular-nums ${pill}`}>{i + 1}</span>
        <span className="relative z-10 flex-1 truncate font-semibold">{p.name}</span>
        <Arrow d={p.delta} />
        <span className="relative z-10 min-w-[3.2em] text-right text-[1.05em] font-extrabold">
          <Ticker to={p.score} ms={900} />
        </span>
      </div>
    )
  }

  /* One sequence, 1..N straight down. Two columns fitted more rows but broke the
     one thing a leaderboard is for: reading places in order. Rank 9 sat at the
     top-right, level with rank 1, so the eye had to jump columns to follow the
     order. Row type is sized in vh instead, so a full board still lands above
     the host's button on a projector without splitting it. */
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-[clamp(.15rem,.5vh,.45rem)]">
      {order.map(row)}
    </div>
  )
}

/** Group an already-sorted board into at most `n` steps, one per distinct score.
 *  Level scores finish level, so a step can hold more than one person and a
 *  two-way tie for first means there is no second step at all. */
function topSteps(rows, n = 3) {
  const steps = []
  for (const r of rows || []) {
    const last = steps[steps.length - 1]
    if (last && last[0].score === r.score) last.push(r)
    else if (steps.length < n) steps.push([r])
    else break
  }
  return steps
}

/* The finale: 3rd, 2nd, then a held beat before 1st lands with confetti — and
   then the podium settles in underneath, deliberately without a second burst. */
export function WinnerFinale({ rows, totalPlayers, stepMs = 1800 }) {
  const host = useRef(null)
  const top3 = topSteps(rows)             // each step is everyone on that score
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
                tracking-tight ${tone(idx).ink}`}>
                {LABEL[idx]}{w.length > 1 && <span className="font-bold"> — a {w.length}-way tie</span>}
              </div>
              <div className="anim-floatin flex flex-wrap items-center justify-center
                gap-x-[clamp(1rem,3vw,2.5rem)] gap-y-3">
                {w.map((p) => (
                  <span key={p.name} className="flex items-center gap-4">
                    <span className={`grid aspect-square place-items-center rounded-full
                      ${tone(idx).fill} ${w.length > 1
                        ? 'w-[clamp(2.2rem,4.6vw,3.8rem)] text-[clamp(1.1rem,2.2vw,1.9rem)]'
                        : 'w-[clamp(3rem,7vw,6rem)] text-[clamp(1.5rem,3.4vw,3rem)]'}`}>
                      {faceOf(p.name)}
                    </span>
                    <span className={`font-extrabold ${w.length > 1
                      ? 'text-[clamp(1rem,2.3vw,1.9rem)]' : 'text-[clamp(1.4rem,3.6vw,3rem)]'}`}>
                      {p.name.split('@')[0]}
                    </span>
                  </span>
                ))}
              </div>
              <div className={`text-[clamp(1.1rem,2.4vw,2rem)] font-extrabold ${tone(idx).ink}`}>
                <Ticker to={w[0].score} ms={700} />
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
  const steps = topSteps(rows)
  return (
    <div className="flex flex-1 items-end justify-center gap-[clamp(.6rem,2vw,2rem)]">
      {POD.map(({ i, h, fill, ink, delay }) => {
        const g = steps[i]
        if (!g) return <div key={i} className="w-[20%] max-w-48" />
        const many = g.length > 1
        return (
          <div key={i} className="relative flex w-[20%] max-w-48 flex-col items-center gap-2">
            {i === 0 && (
              <div className="anim-rise absolute -top-[clamp(1.4rem,3vw,2.6rem)]
                text-[clamp(1.2rem,2.8vw,2.4rem)]"
                style={{ animationDelay: '540ms' }}>👑</div>
            )}
            <div className="flex flex-wrap items-end justify-center gap-1">
              {g.map((p) => (
                <div key={p.name} className={`grid aspect-square place-items-center rounded-full
                  ${fill} ${many ? 'w-[clamp(1.4rem,3vw,2.6rem)] text-[clamp(.7rem,1.5vw,1.3rem)]'
                    : 'w-[clamp(2.2rem,5vw,4.4rem)] text-[clamp(1.1rem,2.6vw,2.2rem)]'}`}>
                  {faceOf(p.name)}
                </div>
              ))}
            </div>
            <div className="max-w-full truncate text-[clamp(.65rem,1.2vw,1.1rem)] text-muted">
              {g.map((p) => p.name.split('@')[0]).join(', ')}
            </div>
            <div className="text-[clamp(1rem,2vw,2rem)] font-extrabold tabular-nums">{g[0].score}</div>
            <div className={`anim-rise grid w-full place-items-center rounded-t-2xl
              text-[clamp(1.1rem,2.2vw,2.2rem)] font-extrabold ${h} ${fill} ${ink}`}
              style={{ animationDelay: `${delay}ms` }}>{i + 1}</div>
          </div>
        )
      })}
    </div>
  )
}

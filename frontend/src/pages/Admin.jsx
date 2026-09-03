import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import {
  login, createQuiz, downloadCsv, EXPORTS, activity, savedQuiz, runSavedQuiz,
  deleteQuiz,
  wsUrl, AuthError,
} from '../lib/api.js'
import { parseQuiz, formatQuiz, EXAMPLE } from '../lib/parseQuiz.js'
import { mergeQuestion, isTimed } from '../lib/question.js'
import { useSocket } from '../lib/useSocket.js'
import {
  Screen, JoinStrip, Button, TimerRing, OptionKey, ResultBars, RaceBoard,
  WinnerFinale, LobbyPills, QuestionMedia, PollColumns, tone, useStopwatch, clock, Logo, QuizTagline, DartLoader,
} from '../ui.jsx'

const TOKEN_KEY = 'quiz.token'
const CODE_KEY = 'quiz.code'
const BASE_KEY = 'quiz.base'   // public address players reach this host at
const READ_KEY = 'quiz.read'   // seconds of reading time, for the builder hint

/* Session lives in localStorage and the token is signed rather than stored on
   the server, so a reload, a new tab, or a server restart all keep you logged in
   and drop you back into the room you were hosting. */
const blankQ = () => ({ text: '', timer: 20, options: ['', ''], correct: 0 })
const todayName = () =>
  `Quiz — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
/* The six per-quiz switches. First value of each is what the app has always done,
   so a quiz built without touching any of this behaves exactly as before. */
const DEFAULT_MODE = {
  identity: 'email', grading: 'graded', scoring: 'absolute',
  reveal: true, board: 'always', timing: 'countdown',
}
const SWITCHES = [
  ['identity', 'Players join by', [['email', 'Their email'], ['name', 'A name they choose'],
    ['anonymous', 'Nothing — anonymous']]],
  ['grading', 'Answers are', [['graded', 'Graded — one is correct'],
    ['feedback', 'A poll — no right answer'],
    ['livepoll', 'A live poll — bars fill as they answer']]],
  ['timing', 'Each question', [['countdown', 'Runs on its timer'],
    ['open', 'Stays open until I close it']]],
  ['scoring', 'Points', [['absolute', 'Faster is worth more'],
    ['relative', 'Faster than the rest of the room'],
    ['flat', 'The same for every correct answer'], ['none', 'No points — just right or wrong']]],
  ['reveal', 'After each one', [[true, 'Show the correct answer'],
    [false, 'Keep the answer hidden']]],
  ['board', 'Leaderboard', [['always', 'After every question'], ['end', 'Only at the end'],
    ['never', 'Never']]],
]
/* Faithful port of clean_mode (backend/app/game.py): the same three dependency
   rules, in the same order. The server re-applies them on save and again when the
   room is built — this is display only, so the builder shows the quiz that will
   actually run rather than the buttons that were clicked. Without it a poll still
   reads "Faster is worth more", and an open question still claims absolute speed. */
const settle = (m) => {
  const out = { ...m }
  if (out.grading === 'feedback' || out.grading === 'livepoll') out.scoring = 'none'
  // a live poll is closed by the host, never by a clock
  if (out.grading === 'livepoll') out.timing = 'open'
  if (out.scoring === 'none') out.board = 'never'
  if (out.timing === 'open' && out.scoring === 'absolute') out.scoring = 'relative'
  return out
}

/* A switch that cannot matter is greyed out rather than hidden, so nothing
   silently disappears while you are reading. */
const switchOff = (m) => ({
  scoring: m.grading !== 'graded',
  reveal: m.grading !== 'graded',
  timing: m.grading === 'livepoll',   // the host closes a live poll
  board: m.grading !== 'graded' || m.scoring === 'none',
})
const summarise = (m) => SWITCHES
  .map(([k, , opts]) => (opts.find(([v]) => v === m[k]) || [])[1])
  .filter(Boolean).join(' · ')

const blankQuiz = () => ({ title: todayName(), capacity: 60, questions: [blankQ()], mode: {} })

export default function Admin() {
  const [token, setTok] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [code, setCod] = useState(() => localStorage.getItem(CODE_KEY))
  const [draft, setDraft] = useState(null)   // non-null while the builder is open

  const setToken = (t) => {
    t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)
    setTok(t)
  }
  const setCode = (c) => {
    c ? localStorage.setItem(CODE_KEY, c) : localStorage.removeItem(CODE_KEY)
    setCod(c)
  }
  const logout = () => { setCode(null); setDraft(null); setToken(null) }

  if (!token) return <Login onToken={setToken} />
  if (code) return <Host token={token} code={code} onExit={() => setCode(null)} onAuthFail={logout} />
  if (draft) {
    return <Builder token={token} initial={draft}
      onCreated={(c) => { setDraft(null); setCode(c) }}
      onCancel={() => setDraft(null)} onAuthFail={logout} />
  }
  return <Dashboard token={token} onNew={() => setDraft(blankQuiz())} onEdit={setDraft}
    onOpen={setCode} onAuthFail={logout} />
}

/* ============================ login ============================ */
function Login({ onToken }) {
  const [u, setU] = useState('Admin')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const { token, read_secs } = await login(u, p)
      localStorage.setItem(READ_KEY, String(read_secs ?? 0))
      onToken(token)
    } catch {
      setErr('Those credentials did not work')
      setBusy(false)   // left true on success — this screen is about to be replaced
    }
  }
  const field = `w-full rounded-2xl border-2 border-line bg-canvas px-4 py-3.5
    outline-none transition placeholder:text-muted/50 focus:border-anchor`
  return (
    <Screen>
      <form onSubmit={submit} className="m-auto flex w-full max-w-sm flex-col gap-4">
        <div className="logo-enter mb-2">
          <h1 className="text-[clamp(2rem,6vw,2.75rem)]"><Logo /></h1>
          <QuizTagline className="mt-3" />
          <p className="mt-4 font-semibold text-muted">Sign in to build and host a quiz.</p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-[.1em] text-muted">Username</span>
          <input value={u} onChange={(e) => setU(e.target.value)} placeholder="Admin"
            aria-label="Username" className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-[.1em] text-muted">Password</span>
          <input type="password" value={p} onChange={(e) => setP(e.target.value)}
            placeholder="••••••••" aria-label="Password" className={field} />
        </label>
        {busy
          ? <div className="mt-1 flex justify-center py-1"><DartLoader size={64} label="Signing in" /></div>
          : <Button type="submit" className="mt-1 py-4 text-lg">Log in</Button>}
        {err && (
          <p role="alert" className="rounded-xl bg-rose px-4 py-3 font-semibold text-rose-ink">
            {err}
          </p>
        )}
      </form>
    </Screen>
  )
}

/* ============================ dashboard ============================ */
const when = (t) => {
  if (!t) return '—'
  const d = new Date(t * 1000)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* Secondary actions live behind ⋯ so each row reads as one thing with one
   obvious button, instead of a wall of CSV / ✕ / Re-run repeated down the page. */
function RowMenu({ row, open, onToggle, onRerun, onEdit, onCsv, onDelete }) {
  const items = [
    row.quiz_id != null && { label: 'Re-run this quiz', fn: onRerun },
    row.quiz_id != null && { label: 'Edit questions', fn: onEdit },
    // always listed, disabled with a reason when that quiz has never finished
    ...Object.entries(EXPORTS).map(([kind, e]) => ({
      label: e.label, fn: () => onCsv(kind), off: !row.code,
      hint: row.code ? null : 'no results',
    })),
    row.quiz_id != null && { label: 'Delete quiz', fn: onDelete, danger: true },
  ].filter(Boolean)
  if (!items.length) return null
  return (
    <div className="relative" data-menu>
      <button onClick={onToggle} aria-label={`More actions for ${row.title}`}
        aria-expanded={open}
        className={`grid size-8 place-items-center rounded-lg text-lg font-bold leading-none
          text-muted hover:bg-white hover:text-ink ${open ? 'bg-white text-ink' : ''}`}>⋯</button>
      {open && (
        <div role="menu"
          className="absolute right-0 top-9 z-20 w-48 overflow-hidden rounded-xl border
            border-line bg-canvas py-1 shadow-lg">
          {items.map((it) => (
            <button key={it.label} role="menuitem" disabled={it.off}
              onClick={() => { onToggle(); it.fn() }}
              className={`flex w-full items-baseline justify-between gap-2 px-4 py-2 text-left
                text-sm font-semibold enabled:hover:bg-track disabled:opacity-40
                ${it.danger ? 'text-rose-ink' : 'text-ink'}`}>
              {it.label}
              {it.hint && <span className="text-xs font-normal text-muted">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Dashboard({ token, onNew, onEdit: openInBuilder, onOpen, onAuthFail }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(null)
  const [menu, setMenu] = useState(null)

  // any click outside a menu closes it
  useEffect(() => {
    const close = (e) => { if (!e.target.closest('[data-menu]')) setMenu(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  const fail = useCallback((e) => (e instanceof AuthError ? onAuthFail() : setErr(e.message)),
    [onAuthFail])

  useEffect(() => { activity(token).then(setData).catch(fail) }, [token, fail])

  const grab = async (code, kind) => {
    try { await downloadCsv(token, code, kind) } catch (e) { fail(e) }
  }

  const rerun = async (row) => {
    setErr(''); setBusy(row.quiz_id)
    try { onOpen(await runSavedQuiz(token, row.quiz_id)) } catch (e) { fail(e); setBusy(null) }
  }

  const edit = async (row) => {
    try { openInBuilder(await savedQuiz(token, row.quiz_id)) } catch (e) { fail(e) }
  }

  const remove = async (row) => {
    try {
      await deleteQuiz(token, row.quiz_id)
      setData((d) => ({ ...d, rows: d.rows.filter((x) => x.quiz_id !== row.quiz_id) }))
    } catch (e) { fail(e) }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl"><Logo /></h1>
        <div className="flex items-center gap-3">
          <Button onClick={onNew}>New quiz</Button>
          <button onClick={onAuthFail}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:text-ink">
            Log out
          </button>
        </div>
      </div>

      {err && <p role="alert" className="mb-4 font-semibold text-rose-ink">{err}</p>}

      {data?.live?.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[.1em] text-muted">
            Running now
          </h2>
          <div className="flex flex-col gap-2">
            {data.live.map((r) => (
              <button key={r.code} onClick={() => onOpen(r.code)}
                className="flex items-center gap-4 rounded-2xl bg-mint px-4 py-3 text-left
                  text-mint-ink transition hover:brightness-[.97]">
                <span className="font-extrabold tracking-[.1em]">{r.code}</span>
                <span className="flex-1 text-sm font-semibold">
                  {r.title && <b className="font-extrabold">{r.title} · </b>}
                  {r.players} joined · {r.questions} question{r.questions === 1 ? '' : 's'} · {r.state}
                </span>
                <span className="text-sm font-extrabold">Resume →</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[.1em] text-muted">
        Recent quizzes
      </h2>

      {!data && (
        <div className="flex flex-col items-center gap-4 py-16">
          <DartLoader label="Loading your quizzes" />
          <p className="font-semibold text-muted">Loading your quizzes…</p>
        </div>
      )}
      {data && !data.rows.length && (
        <div className="rounded-2xl border border-dashed border-line px-8 py-12 text-center">
          <p className="text-lg font-extrabold">No quizzes yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
            Build one and it stays here, ready to run again with a fresh room code
            whenever you need it.
          </p>
          <Button onClick={onNew} className="mt-5">Build your first quiz</Button>
        </div>
      )}

      {/* Title leads, everything about it sits underneath — the old single line
          gave the name, the counts and the winner all the same weight, so a list
          of ten quizzes read as one block of text. The whole row re-runs; the ⋯
          keeps the rarer actions without competing for the click. */}
      <div className="flex flex-col gap-2">
        {data?.rows.map((row) => {
          const id = row.quiz_id ?? row.code
          const canRun = row.quiz_id != null
          return (
            <div key={id}
              onClick={canRun && !busy ? () => rerun(row) : undefined}
              className={`group flex items-center gap-4 rounded-2xl border border-transparent
                bg-track px-4 py-3.5 transition
                ${canRun ? 'cursor-pointer hover:border-line hover:bg-canvas' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="truncate text-[1.05rem] font-extrabold">{row.title}</span>
                  {row.winner && (
                    <span className="flex items-center gap-1.5 rounded-full bg-butter px-2.5 py-0.5
                      text-xs font-semibold text-butter-ink">
                      🏆 {(row.winner.name || '?').split('@')[0]}
                      <b className="font-extrabold tabular-nums">{row.winner.score}</b>
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-muted">
                  {row.questions} question{row.questions === 1 ? '' : 's'} · {when(row.last_run)}
                  {row.players != null && ` · ${row.players} player${row.players === 1 ? '' : 's'}`}
                </p>
              </div>
              {busy === row.quiz_id ? (
                <span className="text-sm font-semibold text-anchor">Starting…</span>
              ) : canRun && (
                <span className="hidden text-sm font-extrabold text-anchor group-hover:inline">
                  Run again →
                </span>
              )}
              <span onClick={(e) => e.stopPropagation()}>
                <RowMenu row={row} open={menu === id}
                  onRerun={() => rerun(row)}
                  onToggle={() => setMenu((m) => (m === id ? null : id))}
                  onEdit={() => edit(row)} onCsv={(kind) => grab(row.code, kind)}
                  onDelete={() => remove(row)} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* The configured seconds are split into reading + answering, so say so rather
   than letting a 10s question silently become 5s of each. */
function TimerSplit({ total, read }) {
  const t = Number(total) || 0
  if (t < 1) return null
  const r = Math.max(0, Math.min(read, t - 1))
  return (
    <span className="whitespace-nowrap text-xs text-muted">
      {r > 0 ? `= ${r}s read + ${t - r}s answer` : 'no reading time'}
    </span>
  )
}

/* ============================ bulk import ============================ */
function BulkImport({ existing, graded, onLoad, onClose }) {
  // opens holding whatever is already in the builder, so the whole quiz can be
  // reworked as text in one go rather than a field at a time
  const [text, setText] = useState(() => formatQuiz(existing))
  const parsed = text.trim() ? parseQuiz(text, graded) : null
  const ready = parsed?.questions.length || 0
  const replacing = existing.filter((q) => q.text.trim()).length

  return (
    <div className="mb-6 rounded-2xl border border-line p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-extrabold">
          {replacing ? 'Edit questions as text' : 'Paste questions'}
        </h2>
        <button onClick={onClose}
          className="text-sm font-semibold text-muted hover:text-ink">Close</button>
      </div>

      <p className="mb-3 text-sm text-muted">
        One question per block. Options start with <code className="rounded bg-track px-1">-</code>,
        and <code className="rounded bg-track px-1">*</code> marks the correct one.
        Add <code className="rounded bg-track px-1">[20]</code> after a question to set its timer.
        JSON works too.
      </p>

      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck="false"
        aria-label="Questions to import" placeholder={EXAMPLE}
        className="w-full resize-y rounded-xl border-2 border-line bg-canvas p-3 font-mono
          text-sm outline-none placeholder:text-muted/50 focus:border-anchor" />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={!ready} onClick={() => onLoad(parsed.questions)}>
          {ready ? `Load ${ready} question${ready === 1 ? '' : 's'}` : 'Load questions'}
        </Button>
        <button onClick={() => setText(EXAMPLE)}
          className="rounded-xl bg-track px-4 py-3 text-sm font-extrabold hover:brightness-95">
          Use the example
        </button>
        {ready > 0 && replacing > 0 && (
          <span className="text-sm text-muted">
            replaces the {replacing} question{replacing === 1 ? '' : 's'} below
          </span>
        )}
      </div>

      {parsed?.errors.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {parsed.errors.map((e, i) => (
            <li key={i} className="flex gap-2 rounded-lg bg-rose px-3 py-1.5 text-sm text-rose-ink">
              {e.line > 0 && <b className="font-extrabold tabular-nums">Line {e.line}</b>}
              <span>{e.msg}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ============================ builder ============================ */
function Builder({ token, initial, onCreated, onCancel, onAuthFail }) {
  const [title, setTitle] = useState(initial.title)
  const [capacity, setCapacity] = useState(initial.capacity)
  const [questions, setQuestions] = useState(
    initial.questions.map((q) => ({ ...q, timer: String(q.timer ?? 20) })))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')      // '' | 'save' | 'start' — which button is in flight
  const [bulk, setBulk] = useState(false)
  const [mode, setMode] = useState(() => ({ ...DEFAULT_MODE, ...(initial.mode || {}) }))
  const [showModes, setShowModes] = useState(false)
  const readSecs = Number(localStorage.getItem(READ_KEY) || 0)
  const patch = (qi, fn) => setQuestions((qs) => qs.map((q, i) => (i === qi ? fn(q) : q)))

  /* run=false saves the quiz and drops back to the dashboard without starting a
     room; onCreated(null) already routes there. */
  const create = async (run) => {
    if (!title.trim()) { setErr('Give the quiz a name so you can find it again'); return }
    setErr(''); setBusy(run ? 'start' : 'save')
    try {
      onCreated(await createQuiz(token, {
        title: title.trim(),
        capacity: Number(capacity),
        mode: settle(mode),
        // options go up as typed: the server drops the blanks and moves `correct`
        // with its own option, so that index shift is decided in exactly one place
        questions: questions.map((q) => ({
          text: q.text.trim(), timer: Number(q.timer) || 20,
          options: q.options,
          correct: q.correct,
          code: q.code?.trim() ? q.code : null,   // omit the optional extras when unused
          image: q.image?.trim() ? q.image.trim() : null,
        })),
      }, run))
    } catch (e) {
      if (e instanceof AuthError) return onAuthFail()
      setErr(e.message)
    } finally { setBusy('') }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          aria-label="Quiz name" placeholder="Name this quiz"
          className="min-w-0 flex-1 rounded-xl border-2 border-transparent bg-track px-3 py-2
            text-2xl font-extrabold tracking-tight outline-none
            placeholder:text-muted/60 focus:border-anchor focus:bg-canvas" />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-muted">
            Room capacity
            <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)}
              className="w-24 rounded-lg border-2 border-line px-2 py-1.5 text-ink
                outline-none focus:border-anchor" />
          </label>
          <button onClick={() => setBulk((b) => !b)}
            className="rounded-xl bg-track px-4 py-2 text-sm font-extrabold hover:brightness-95">
            {questions.some((q) => q.text.trim()) ? 'Edit all as text' : 'Paste questions'}
          </button>
          <button onClick={onCancel}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:text-ink">
            Cancel
          </button>
        </div>
      </div>

      {/* How this quiz runs. Collapsed to one sentence by default, because the
          default is what the app has always done and most quizzes never touch it. */}
      <div className="mb-6 mt-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted">
          <span className="font-semibold">{summarise(settle(mode))}</span>
          <button onClick={() => setShowModes((s) => !s)}
            className="font-semibold text-anchor hover:underline">
            {showModes ? 'Done' : 'Change'}
          </button>
        </div>
        {/* Segmented rows rather than dropdowns: six selects hid every choice
            behind a click, so nobody discovered the modes existed. Laid out flat,
            the whole grammar of a quiz reads in one glance — and a switch the
            others have settled greys out in place instead of vanishing. */}
        {showModes && (
          <div className="mt-3 flex flex-col gap-4 rounded-2xl border border-line
            bg-track/40 p-[clamp(1rem,2vw,1.5rem)]">
            <h3 className="text-xs font-semibold uppercase tracking-[.1em] text-muted">
              How this quiz runs
            </h3>
            {SWITCHES.map(([key, label, opts]) => {
              const off = switchOff(mode)[key]
              // absolute speed needs a fixed window, which an open question has not
              const choices = key === 'scoring' && mode.timing === 'open'
                ? opts.filter(([v]) => v !== 'absolute') : opts
              const current = settle(mode)[key]
              return (
                <div key={key} className={off ? 'opacity-45' : ''}>
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-ink">{label}</span>
                    {off && <span className="text-xs font-medium text-muted">
                      settled by the choices above
                    </span>}
                  </div>
                  <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
                    {choices.map(([v, text]) => {
                      const on = v === current
                      return (
                        <button key={String(v)} type="button" disabled={off}
                          aria-pressed={on}
                          onClick={() => setMode((m) => ({ ...m, [key]: v }))}
                          className={`rounded-full px-3.5 py-2 text-sm font-semibold transition
                            enabled:hover:brightness-95 disabled:cursor-not-allowed
                            ${on ? 'bg-anchor text-white' : 'bg-canvas text-muted border border-line'}`}>
                          {text}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {bulk && (
        <BulkImport existing={questions} graded={mode.grading === 'graded'}
          onClose={() => setBulk(false)}
          onLoad={(qs) => {
            setQuestions(qs.map((q) => ({ ...q, timer: String(q.timer) })))
            setBulk(false)
            setErr('')
          }} />
      )}

      <div className="flex flex-col gap-5">
        {questions.map((q, qi) => (
          <div key={qi} className="rounded-2xl border border-line p-5">
            <div className="mb-4 flex items-center gap-3">
              <span className="font-extrabold text-anchor">Q{qi + 1}</span>
              <input value={q.text} onChange={(e) => patch(qi, (x) => ({ ...x, text: e.target.value }))}
                placeholder="Question" aria-label={`Question ${qi + 1} text`}
                className="flex-1 rounded-lg border-2 border-line px-3 py-2 outline-none focus:border-anchor" />
              <label className="flex items-center gap-1.5 text-sm text-muted">
                <input type="number" min="1" value={q.timer} aria-label="Seconds"
                  onChange={(e) => patch(qi, (x) => ({ ...x, timer: e.target.value }))}
                  className="w-16 rounded-lg border-2 border-line px-2 py-2 text-center text-ink
                    outline-none focus:border-anchor" />s
                {readSecs > 0 && <TimerSplit total={q.timer} read={readSecs} />}
              </label>
              {questions.length > 1 && (
                <button onClick={() => setQuestions((qs) => qs.filter((_, i) => i !== qi))}
                  aria-label={`Remove question ${qi + 1}`}
                  className="rounded-lg px-2 py-1 font-bold text-muted hover:text-rose-ink">✕</button>
              )}
            </div>

            {(q.code || q.image || q.extras) ? (
              <div className="mb-3 flex flex-col gap-2">
                <textarea value={q.code || ''} rows={4} spellCheck="false"
                  aria-label={`Code snippet for question ${qi + 1}`}
                  placeholder="Optional code snippet — shown above the options"
                  onChange={(e) => patch(qi, (x) => ({ ...x, code: e.target.value }))}
                  className="w-full resize-y rounded-lg border-2 border-line bg-track p-3 font-mono
                    text-sm outline-none placeholder:text-muted/60 focus:border-anchor" />
                <input value={q.image || ''} aria-label={`Image URL for question ${qi + 1}`}
                  placeholder="Optional image URL — https://…"
                  onChange={(e) => patch(qi, (x) => ({ ...x, image: e.target.value }))}
                  className="w-full rounded-lg border-2 border-line px-3 py-2 text-sm
                    outline-none placeholder:text-muted/60 focus:border-anchor" />
              </div>
            ) : (
              <button onClick={() => patch(qi, (x) => ({ ...x, extras: true }))}
                className="mb-3 text-sm font-semibold text-anchor hover:underline">
                + Add code snippet or image
              </button>
            )}

            <div className="flex flex-col gap-2">
              {q.options.map((opt, oi) => {
                const t = tone(oi)
                return (
                  <div key={oi} className={`flex items-center gap-3 rounded-xl ${t.fill} px-3 py-2`}>
                    <input type="radio" name={`c${qi}`} checked={q.correct === oi}
                      onChange={() => patch(qi, (x) => ({ ...x, correct: oi }))}
                      aria-label={`Mark option ${t.key} correct`} className="size-4 accent-mint-ink" />
                    <OptionKey className={t.ink}>{t.key}</OptionKey>
                    <input value={opt} placeholder={`Option ${t.key}`} aria-label={`Option ${t.key}`}
                      onChange={(e) => patch(qi, (x) => ({
                        ...x, options: x.options.map((o, i) => (i === oi ? e.target.value : o)),
                      }))}
                      className={`flex-1 bg-transparent font-semibold outline-none
                        ${t.ink} placeholder:opacity-50`} />
                    {q.options.length > 2 && (
                      <button aria-label={`Remove option ${t.key}`}
                        onClick={() => patch(qi, (x) => ({
                          ...x,
                          options: x.options.filter((_, i) => i !== oi),
                          correct: x.correct >= oi && x.correct > 0 ? x.correct - 1 : x.correct,
                        }))}
                        className={`font-bold opacity-50 hover:opacity-100 ${t.ink}`}>✕</button>
                    )}
                  </div>
                )
              })}
              {q.options.length < 6 && (
                <button onClick={() => patch(qi, (x) => ({ ...x, options: [...x.options, ''] }))}
                  className="self-start text-sm font-semibold text-anchor hover:underline">
                  + Add option
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={() => setQuestions((qs) => [...qs, blankQ()])}
          className="rounded-xl bg-track px-5 py-3.5 font-extrabold hover:brightness-95">
          + Add question
        </button>
        <Button onClick={() => create(false)} disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : 'Save for later'}
        </Button>
        <button onClick={() => create(true)} disabled={!!busy}
          className="rounded-xl bg-track px-5 py-3.5 font-extrabold hover:brightness-95
            disabled:opacity-60">
          {busy === 'start' ? 'Creating…' : 'Save & start now'}
        </button>
        {err && <span role="alert" className="font-semibold text-rose-ink">{err}</span>}
      </div>
    </div>
  )
}

/* How much of the room is in. The bar matters more than the words: a host
   glancing up from the class needs "are they done yet" in one look, and the
   count alone made them read two numbers and divide. */
function Answered({ answered, total }) {
  const frac = total ? Math.min(1, answered / total) : 0
  const done = total > 0 && answered >= total
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="flex items-baseline gap-3">
        <b className={`text-[clamp(1.6rem,4vw,3.4rem)] font-extrabold tabular-nums
          ${done ? 'text-mint-ink' : ''}`}>{answered}</b>
        <span className="font-semibold text-muted">
          of {total} answered{done ? ' — everyone is in' : ''}
        </span>
      </span>
      <span className="h-1.5 w-[min(22rem,60%)] overflow-hidden rounded-full bg-track">
        <span className={`block h-full rounded-full transition-[width,background-color]
          duration-500 ease-out ${done ? 'bg-mint-ink' : 'bg-anchor'}`}
          style={{ width: `${frac * 100}%` }} />
      </span>
    </span>
  )
}

/* ============================ host console ============================ */
function Host({ token, code, onExit, onAuthFail }) {
  const [lobby, setLobby] = useState({ players: [], count: 0, capacity: 0 })
  const [phase, setPhase] = useState('lobby')
  const [question, setQuestion] = useState(null)
  const [progress, setProgress] = useState({ answered: 0, total: 0 })
  const [results, setResults] = useState(null)
  const [over, setOver] = useState(null)
  const [qr, setQr] = useState('')

  /* Players scan whatever this host is reachable at. Opening the console through
     a tunnel already gives the right origin; this override covers hosting on
     localhost while players come in over ngrok. */
  const [base, setBase] = useState(() => localStorage.getItem(BASE_KEY) || location.origin)
  const cleanBase = base.trim().replace(/\/+$/, '') || location.origin
  const joinUrl = `${cleanBase}/join/${code}`
  let publicHost = location.host
  try { publicHost = new URL(cleanBase).host } catch { /* mid-typing, keep the last good one */ }

  useEffect(() => {
    QRCode.toDataURL(joinUrl, { margin: 1, width: 260, color: { dark: '#1B2333', light: '#FFFFFF' } })
      .then(setQr).catch(() => setQr(''))
  }, [joinUrl])

  const onMsg = useCallback((m) => {
    switch (m.type) {
      case 'error': if (m.msg === 'Room not found') onExit(); break
      // `waiting` is the between-questions lobby — the server holds the room
      // there until the host starts the next question
      case 'lobby': setLobby(m); if (m.state === 'waiting') setPhase('waiting'); break
      case 'question':
        // The reading-phase payload has no options, so this merges to let the
        // later answering payload fill them in. But timing keys are OMITTED
        // rather than nulled when they do not apply — an open question sends
        // `elapsed` and no `remaining` — and a spread cannot unset a key the
        // new payload leaves out. The reading phase's `remaining` therefore
        // survived into the answering phase and drew a countdown on a question
        // the host is supposed to close by hand. Clear them before merging.
        setQuestion((q) => mergeQuestion(q, m))
        // seed from the payload: the console used to sit on "0 of 0 answered"
        // until the first tap, which is exactly when you most want the number
        if (m.phase !== 'reading') setProgress({ answered: m.answered ?? 0, total: m.players ?? 0 })
        setPhase('question'); break
      case 'progress':
        setProgress(m)
        // a live poll's columns arrive on this message; hold them on the question
        if (m.tally) setQuestion((q) => (q ? { ...q, tally: m.tally } : q))
        break
      // one payload drives both insight screens; the host steps through them
      case 'results': setResults(m); setPhase('bars'); break
      case 'game_over': setOver(m); setPhase('over'); break
      default: break
    }
  }, [onExit])

  const { status, send } = useSocket(wsUrl(`/ws/host/${code}?token=${token}`), onMsg)
  const waiting = phase === 'waiting'
  // the question about to be asked, 1-based. `question` still holds the one just
  // finished, so the next is its index + 2
  const nextQ = question ? question.index + 2 : null
  const players = phase === 'lobby' || waiting
    ? `${lobby.count} / ${lobby.capacity} joined` : `${lobby.count} players`

  const grab = async (kind) => {
    try { await downloadCsv(token, code, kind) } catch (e) { if (e instanceof AuthError) onAuthFail() }
  }
  // the room holds on the insights screen until this is sent
  const [advancing, setAdvancing] = useState(false)
  // only show it as advancing if the request actually left — otherwise the button
  // greys out on a dead socket and the host is stuck with no idea why
  // also closes an open question — the server accepts `next` there too
  const next = () => { if (send({ type: 'next' })) setAdvancing(true) }
  const openFor = useStopwatch(phase === 'question' ? question?.elapsed : null,
    `${question?.index}:${question?.phase}`)

  // navigator.clipboard does not exist on a plain-http origin, which is exactly
  // how this gets hosted for a class (http://<laptop-ip>:8000). Fall back to the
  // old selection API, and always confirm, so the button is never silently dead.
  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(joinUrl)
      else {
        const ta = document.createElement('textarea')
        ta.value = joinUrl
        ta.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* the URL is on screen anyway — copy it by hand */ }
  }
  useEffect(() => { setAdvancing(false) }, [results, over])

  return (
    <Screen>
      <JoinStrip code={code} right={players} host={publicHost} />

      {/* The same screen opens the quiz and gates every question after it: the
          room code and a QR big enough to scan from a seat, who is in, and one
          button that does not move until the host presses it. Between questions
          that is the whole point — latecomers get a door, and nobody is halfway
          through reading Q4 when it appears. */}
      {(phase === 'lobby' || phase === 'waiting') && (
        <div className="grid flex-1 grid-cols-1 items-stretch gap-6 md:grid-cols-[minmax(0,31%)_1fr]">
          <div className="flex flex-col items-center justify-center gap-3 rounded-3xl bg-track p-6">
            <span className="text-xs font-semibold uppercase tracking-[.1em] text-muted">Room code</span>
            <span className="text-[clamp(1.8rem,4vw,3.4rem)] font-extrabold tracking-[.12em] text-anchor">
              {code}
            </span>
            {qr && <img src={qr} alt={`QR code to join room ${code}`} className="w-[min(58%,15rem)] rounded-xl" />}
            <button onClick={copyLink} title="Copy join link"
              className={`max-w-full truncate text-xs hover:text-anchor
                ${copied ? 'font-bold text-mint-ink' : 'text-muted'}`}>
              {copied ? 'Copied ✓' : joinUrl}
            </button>
            <input value={base} aria-label="Public address players use"
              placeholder="https://your-tunnel.ngrok-free.app"
              onChange={(e) => {
                setBase(e.target.value)
                localStorage.setItem(BASE_KEY, e.target.value)
              }}
              className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-center
                text-xs outline-none placeholder:text-muted/50 focus:border-anchor" />
            <span className="text-[11px] text-muted">
              Public address — change it if players join through a tunnel
            </span>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {lobby.title && (
              <h1 className="text-[clamp(1.3rem,3vw,2.6rem)] font-extrabold leading-tight
                tracking-tight text-balance">{lobby.title}</h1>
            )}
            <p className="text-[clamp(1rem,1.8vw,1.5rem)] font-semibold text-muted">
              <b className="text-[1.25em] font-extrabold text-ink tabular-nums">{lobby.count}</b>
              {' '}of {lobby.capacity} joined — waiting for you to start
              {waiting && nextQ && (
                <span className="ml-1">· question {nextQ} of {question?.total ?? '—'} is next</span>
              )}
            </p>
            {lobby.count
              ? <LobbyPills players={lobby.players} />
              : <p className="flex-1 text-muted">No one has joined yet.</p>}
            <div className="flex items-center gap-3">
              <Button className="text-lg" disabled={!lobby.count}
                onClick={() => send({ type: waiting ? 'begin' : 'start' })}>
                {waiting ? `Start question ${nextQ} →` : 'Start the quiz'}
              </Button>
              {!waiting && (
                <button onClick={onExit}
                  className="rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:text-ink">
                  Back
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'question' && question && (
        <>
          <h2 className="flex-none text-[clamp(1.4rem,4.2vw,4rem)] font-extrabold leading-tight
            tracking-tight text-balance">{question.text}</h2>
          <QuestionMedia code={question.code} image={question.image} />

          {question.phase === 'reading' ? (
            /* question alone first — nobody can answer, nothing is being timed */
            <div className="flex flex-1 flex-col items-center justify-center gap-2">
              <TimerRing remaining={question.remaining} total={question.window}
                qkey={`r${question.index}`} className="w-[clamp(5rem,12vw,9rem)]" />
              <p className="text-[clamp(.9rem,1.8vw,1.4rem)] font-semibold text-muted">
                Read the question — options open in a moment
              </p>
            </div>
          ) : (
            <>
              {/* a live poll fills its columns as the taps land; every other
                  question just shows the options and keeps the counts private */}
              {question.tally ? (
                <PollColumns tally={question.tally} options={question.options} />
              ) : (
                <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                  {question.options.map((o, i) => {
                    const t = tone(i)
                    return (
                      <div key={i} style={{ animationDelay: `${i * 70}ms` }}
                        className={`anim-pop flex items-center gap-3 rounded-2xl px-5
                          text-[clamp(1rem,2vw,1.9rem)] font-semibold ${t.fill} ${t.ink}`}>
                        <OptionKey>{t.key}</OptionKey>{o}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="flex flex-none items-center justify-between gap-4">
                <Answered {...progress} />
                {/* on a clock, the ring counts down and closes it. Open, the clock
                    counts up and the only thing that closes it is this button. */}
                {isTimed(question) ? (
                  <TimerRing remaining={question.remaining} total={question.window}
                    qkey={question.index} className="w-[clamp(4rem,9vw,7.5rem)]" />
                ) : (
                  <span className="flex items-center gap-4">
                    <b className="text-[clamp(1.6rem,4vw,3.4rem)] font-extrabold tabular-nums text-muted">
                      {clock(openFor)}
                    </b>
                    <Button onClick={next} disabled={advancing} className="flex-none">
                      {question.tally ? 'Close poll →' : 'Finish question →'}
                    </Button>
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* step 1 — what everyone picked */}
      {phase === 'bars' && results && (
        <>
          <div className="flex flex-none items-baseline gap-4">
            <h2 className="text-[clamp(1.2rem,3vw,2.6rem)] font-extrabold tracking-tight text-balance">
              {question?.text}
            </h2>
          </div>
          {/* keep the snippet on screen while the room discusses the answer */}
          <QuestionMedia code={results.code} image={results.image} className="max-h-[26vh]" />
          {/* a live poll settles into the columns it just filled, rather than
              swapping to a different chart of the same numbers */}
          {results.poll || question?.tally
            ? <PollColumns tally={results.tally} options={results.options} />
            : <ResultBars tally={results.tally} options={results.options}
                correct={results.correct} />}
          <div className="flex flex-none items-center justify-between gap-4">
            <span className="font-semibold text-muted">
              {results.correct != null
                ? <>Correct answer · {results.options[results.correct]} ·{' '}
                  {results.tally[results.correct]} of {results.total_players} got it</>
                : <>{results.tally.reduce((a, b) => a + b, 0)} of {results.total_players} answered</>}
            </span>
            {/* one forward button, whatever comes next — with no leaderboard to show,
                this is the only thing that advances the room */}
            <Button onClick={results.leaderboard
              ? () => { send({ type: 'board' }); setPhase('board') } : next}
              disabled={!results.leaderboard && advancing} className="flex-none">
              {results.leaderboard ? 'Show leaderboard →'
                : results.last ? 'Show final results' : 'Next question →'}
            </Button>
          </div>
        </>
      )}

      {/* step 2 — where that leaves everyone */}
      {phase === 'board' && results && (
        <>
          <div className="flex flex-none items-baseline gap-4">
            <h2 className="text-[clamp(1.5rem,3vw,2.6rem)] font-extrabold tracking-tight">Leaderboard</h2>
            <span className="font-semibold text-muted">
              After question {results.index + 1} of {question?.total ?? '—'}
            </span>
          </div>
          <RaceBoard rows={results.leaderboard} />
          <div className="flex flex-none items-center justify-between gap-4">
            {/* No QR here. The waiting screen before the next question is a
                full join screen already, so a second invitation on top of the
                standings just competes with them — and this is the one screen
                the room is meant to be reading, not scanning. */}
            <span className="font-semibold text-muted">
              Top {results.leaderboard.length} of {results.total_players} players
            </span>
            <div className="flex flex-none items-center gap-2">
              <button onClick={() => setPhase('bars')}
                className="rounded-xl px-4 py-3 font-semibold text-muted hover:text-ink">
                ← Back to results
              </button>
              <Button onClick={next} disabled={advancing} className="flex-none">
                {results.last ? 'Show final results' : 'Next question →'}
              </Button>
            </div>
          </div>
        </>
      )}

      {phase === 'over' && over && (
        <>
          {/* nothing was scored, so there is no podium to build — close on the
              fact that everyone took part rather than on an empty stage */}
          {over.leaderboard
            ? <WinnerFinale rows={over.leaderboard} totalPlayers={over.total_players} />
            : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <div className="text-[clamp(1.6rem,4.6vw,4rem)] font-extrabold tracking-tight">
                  That's the last question
                </div>
                <p className="text-[clamp(1rem,2vw,1.6rem)] font-semibold text-muted">
                  {over.total_players} took part
                </p>
              </div>
            )}
          <div className="flex flex-none flex-wrap items-center justify-center gap-2">
            {/* by rank, not by index — a tie on the podium makes them differ,
                and slicing by index would list a medallist again as 4th */}
            {(over.leaderboard || []).filter((p) => (p.rank ?? 99) > 3).slice(0, 5).map((p) => (
              <span key={p.name} className="rounded-full bg-track px-4 py-1.5
                text-[clamp(.7rem,1.2vw,1rem)] font-semibold">
                {p.rank} · {p.name.split('@')[0]}{' '}
                <b className="font-extrabold tabular-nums">{p.score}</b>
              </span>
            ))}
            <Button onClick={() => grab('report')}>Download report</Button>
            {/* the report is the one worth pressing, so it is the filled button;
                the narrower cuts sit beside it for whoever wants just one */}
            {['scores', 'responses', 'questions'].map((k) => (
              <button key={k} onClick={() => grab(k)}
                className="rounded-xl bg-track px-4 py-3 text-[clamp(.7rem,1.2vw,.95rem)]
                  font-semibold hover:brightness-95">
                {EXPORTS[k].label}
              </button>
            ))}
            <button onClick={onExit}
              className="rounded-xl px-4 py-3 font-semibold text-muted hover:text-ink">Done</button>
          </div>
        </>
      )}

      {status !== 'open' && (
        <p className="flex-none text-center text-sm font-semibold text-peach-ink">Reconnecting…</p>
      )}
    </Screen>
  )
}


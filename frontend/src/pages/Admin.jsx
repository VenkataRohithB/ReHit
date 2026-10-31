import { Fragment, useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import {
  login, createQuiz, downloadCsv, EXPORTS, activity, savedQuiz, runSavedQuiz,
  deleteQuiz,
  wsUrl, AuthError,
} from '../lib/api.js'
import { parseQuiz, formatQuiz, EXAMPLE } from '../lib/parseQuiz.js'
import { mergeQuestion, isTimed, asList, answerText } from '../lib/question.js'
import { useSocket } from '../lib/useSocket.js'
import {
  Screen, JoinStrip, Button, TimerRing, OptionKey, ResultBars, RaceBoard,
  WinnerFinale, LobbyPills, QuestionMedia, PollColumns, AverageMeter, tone, useStopwatch, clock, Logo, QuizTagline, DartLoader,
} from '../ui.jsx'

const TOKEN_KEY = 'quiz.token'
const BASE_KEY = 'quiz.base'   // public address players reach this host at
const READ_KEY = 'quiz.read'   // seconds of reading time, for the builder hint

/* Session lives in localStorage and the token is signed rather than stored on
   the server, so a reload, a new tab, or a server restart all keep you logged in.
   The room you are hosting is in the URL (/admin/quiz/<code>), so a reload lands
   back on it and `/` is always the dashboard. */
const blankQ = () => ({ text: '', timer: 20, options: ['', ''], correct: 0, min: '1', max: '10' })
const todayName = () =>
  `Quiz — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
/* The per-quiz switches. First value of each is what the app has always done,
   so a quiz built without touching any of this behaves exactly as before. */
const DEFAULT_MODE = {
  identity: 'email', grading: 'graded', scoring: 'absolute',
  reveal: true, board: 'always', timing: 'countdown',
}
/* What kind of quiz this is — the `grading` switch, promoted to the first choice
   because it decides which of the rest still mean anything. */
const TYPES = [
  ['graded', 'Graded quiz', 'One right answer. Points and a leaderboard.'],
  ['feedback', 'Poll', 'No right answer. Results after each question.'],
  ['livepoll', 'Live poll', 'Bars fill on the screen as the room votes.'],
  ['average', 'Live average', 'Everyone types a number. The screen shows the average.'],
]
const SWITCHES = [
  ['identity', 'Players join with', [['email', 'Email'], ['name', 'A name'],
    ['anonymous', 'Nothing']]],
  ['timing', 'Each question', [['countdown', 'Runs on its timer'],
    ['open', 'Stays open till I close it']]],
  ['scoring', 'Points', [['absolute', 'Faster earns more'],
    ['relative', 'Beat the room'], ['flat', 'Flat'], ['none', 'None']]],
  ['reveal', 'Correct answer', [[true, 'Show it'], [false, 'Keep it hidden']]],
  ['board', 'Leaderboard', [['always', 'Every question'], ['end', 'Only at the end'],
    ['never', 'Never']]],
]
/* Faithful port of clean_mode (backend/app/game.py): the same dependency rules, in
   the same order. The server re-applies them on save and again when the room is
   built — this is display only, so the builder shows the quiz that will actually
   run rather than the buttons that were clicked. */
const settle = (m) => {
  const out = { ...m }
  if (out.grading !== 'graded') out.scoring = 'none'
  // a live poll or average is closed by the host, never by a clock
  if (out.grading === 'livepoll' || out.grading === 'average') out.timing = 'open'
  if (out.scoring === 'none') out.board = 'never'
  if (out.timing === 'open' && out.scoring === 'absolute') out.scoring = 'relative'
  return out
}

/* Rows the chosen type has already decided. Hidden rather than greyed: with the
   type picked first, a poll with no "Points" row explains itself. */
const settled = (m) => ({
  scoring: m.grading !== 'graded',
  reveal: m.grading !== 'graded',
  timing: m.grading === 'livepoll' || m.grading === 'average',
  board: m.grading !== 'graded' || m.scoring === 'none',
})
const summarise = (m, capacity) => {
  const off = settled(m)
  return [TYPES.find(([v]) => v === m.grading)?.[1],
    ...SWITCHES.filter(([k]) => !off[k])
      .map(([k, label, opts]) => `${label.toLowerCase()} ${
        (opts.find(([v]) => v === m[k]) || [])[1]?.toLowerCase()}`),
    `up to ${capacity} players`].filter(Boolean).join(' · ')
}

/* A row of connected choices — one decision, every option visible at once. */
function Segmented({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label}
      className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-track p-1">
      {options.map(([v, text]) => {
        const on = v === value
        return (
          <button key={String(v)} type="button" aria-pressed={on} onClick={() => onChange(v)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition
              ${on ? 'bg-canvas text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink'}`}>
            {text}
          </button>
        )
      })}
    </div>
  )
}

const blankQuiz = () => ({ title: todayName(), capacity: 60, questions: [blankQ()], mode: {} })

export default function Admin() {
  const [token, setTok] = useState(() => localStorage.getItem(TOKEN_KEY))
  const { code } = useParams()
  const navigate = useNavigate()
  const [draft, setDraft] = useState(null)   // non-null while the builder is open

  const setToken = (t) => {
    t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)
    setTok(t)
  }
  const openRoom = (c) => { setDraft(null); if (c) navigate(`/admin/quiz/${c}`) }
  // not logging out of the room: it keeps running and stays under "Running now"
  const goHome = () => navigate('/')
  const logout = () => { setDraft(null); setToken(null) }

  // on /admin/quiz/<code> with no session, log in right here and carry on into it
  if (!token) return <Login onToken={setToken} />
  if (code) {
    return <Host key={code} token={token} code={code} onExit={goHome} onAuthFail={logout}
      onGone={() => navigate('/', { replace: true })} />
  }
  if (draft) {
    return <Builder token={token} initial={draft}
      onCreated={openRoom}
      onCancel={() => setDraft(null)} onAuthFail={logout} />
  }
  return <Dashboard token={token} onNew={() => setDraft(blankQuiz())} onEdit={setDraft}
    onOpen={openRoom} onAuthFail={logout} />
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
          <h1 className="text-[clamp(2rem,6vw,2.75rem)]"><Logo to="/" /></h1>
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
/* quiz type → [value, label, chip colours]; the same four as the builder's cards */
const KIND = {
  graded: ['graded', 'Graded', 'bg-peri text-peri-ink'],
  feedback: ['feedback', 'Poll', 'bg-butter text-butter-ink'],
  livepoll: ['livepoll', 'Live poll', 'bg-mint text-mint-ink'],
  average: ['average', 'Live average', 'bg-lilac text-lilac-ink'],
}

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
  const [tab, setTab] = useState('quizzes')
  const [q, setQ] = useState('')

  // a row without a quiz_id is a game whose quiz was deleted — it lives on under
  // Past games, which reads every finished game straight from history
  const quizzes = (data?.rows || []).filter((r) => r.quiz_id != null)
  const games = data?.games || []
  const needle = q.trim().toLowerCase()
  const match = (r) => !needle || r.title.toLowerCase().includes(needle)
  const foundQuizzes = quizzes.filter(match)
  const foundGames = games.filter(match)
  // one page each, so a long history never turns into an endless scroll; a new
  // search or tab starts back at page 1
  const [page, setPage] = useState({ quizzes: 0, games: 0 })
  useEffect(() => setPage({ quizzes: 0, games: 0 }), [q])

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

  const gameTable = (rows) => (
    <div className="overflow-x-auto">
      <div className="min-w-[34rem]">
        <div className={`${GAME_COLS} border-b border-line px-3 pb-2 text-xs font-extrabold
          uppercase tracking-[.08em] text-muted`}>
          <span>Game</span><span>Players</span><span>Class avg</span><span>Got it right</span><span />
        </div>
        {rows.map((g) => (
          <div key={g.code} className={`${GAME_COLS} border-b border-line px-3 py-3`}>
            <span className="min-w-0">
              <b className="block truncate font-extrabold">{g.title}</b>
              <span className="text-sm font-semibold text-muted">
                {when(g.ended)}
                {g.winner && <> · 🏆 {(g.winner.name || '?').split('@')[0]}</>}
              </span>
            </span>
            <span className="font-semibold tabular-nums">{g.players}</span>
            <span className="font-semibold tabular-nums">
              {g.average_score != null ? Math.round(g.average_score).toLocaleString() : '—'}
            </span>
            {/* only a graded game has a right answer to measure */}
            {g.accuracy != null ? (
              <span className="h-2 overflow-hidden rounded-full bg-track"
                title={`${Math.round(g.accuracy)}% correct`}>
                <span className="block h-full rounded-full bg-mint-ink" style={{ width: `${g.accuracy}%` }} />
              </span>
            ) : <span className="text-muted">—</span>}
            <span onClick={(e) => e.stopPropagation()}>
              <RowMenu row={{ ...g, quiz_id: null }} open={menu === g.code}
                onToggle={() => setMenu((m) => (m === g.code ? null : g.code))}
                onCsv={(kind) => grab(g.code, kind)} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-3xl"><Logo to="/" /></h1>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search quizzes" aria-label="Search quizzes and games"
          className="order-last w-full rounded-xl border-2 border-line px-3 py-2 text-sm outline-none
            placeholder:text-muted/60 focus:border-anchor sm:order-none sm:w-64" />
        <Button onClick={onNew}>New quiz</Button>
        <button onClick={onAuthFail}
          className="rounded-xl px-2 py-2 text-sm font-semibold text-muted hover:text-ink">
          Log out
        </button>
      </div>

      {err && <p role="alert" className="mb-4 font-semibold text-rose-ink">{err}</p>}

      {data?.live?.length > 0 && (
        <section className="mb-6">
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

      <div role="tablist" className="mb-5 flex w-fit gap-1 rounded-xl bg-track p-1">
        {[['quizzes', 'My quizzes', quizzes.length], ['games', 'Past games', games.length]].map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition
              ${tab === k ? 'bg-canvas text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink'}`}>
            {label}{data && <span className="tabular-nums"> · {n}</span>}
          </button>
        ))}
      </div>

      {!data && (
        <div className="flex flex-col items-center gap-4 py-16">
          <DartLoader label="Loading your quizzes" />
          <p className="font-semibold text-muted">Loading your quizzes…</p>
        </div>
      )}

      {data && tab === 'quizzes' && (
        <>
          {!quizzes.length ? (
            <div className="rounded-2xl border border-dashed border-line px-8 py-12 text-center">
              <p className="text-lg font-extrabold">No quizzes yet</p>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
                Build one and it stays here, ready to run again with a fresh room code
                whenever you need it.
              </p>
              <Button onClick={onNew} className="mt-5">Build your first quiz</Button>
            </div>
          ) : !foundQuizzes.length ? (
            <p className="py-10 text-center text-muted">No quiz matches “{q}”.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pageOf(foundQuizzes, page.quizzes, QUIZ_PAGE).map((row) => {
                  const [, typeName, fill] = KIND[row.grading] || KIND.graded
                  return (
                    <div key={row.quiz_id}
                      className="flex flex-col gap-2 rounded-2xl border border-line p-4 transition hover:shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-extrabold ${fill}`}>{typeName}</span>
                        <span onClick={(e) => e.stopPropagation()}>
                          <RowMenu row={row} open={menu === row.quiz_id}
                            onRerun={() => rerun(row)}
                            onToggle={() => setMenu((m) => (m === row.quiz_id ? null : row.quiz_id))}
                            onEdit={() => edit(row)} onCsv={(kind) => grab(row.code, kind)}
                            onDelete={() => remove(row)} />
                        </span>
                      </div>
                      <b className="text-[1.05rem] font-extrabold leading-snug">{row.title}</b>
                      <p className="text-sm font-semibold text-muted">
                        {row.questions} question{row.questions === 1 ? '' : 's'} ·{' '}
                        {row.code ? `last run ${day(row.last_run)}` : 'never run'}
                      </p>
                      <div className="mt-auto flex gap-2 pt-1">
                        <button onClick={() => rerun(row)} disabled={!!busy}
                          className="rounded-lg bg-anchor px-3.5 py-1.5 text-sm font-extrabold text-white
                            hover:brightness-105 disabled:opacity-60">
                          {busy === row.quiz_id ? 'Starting…' : 'Run'}
                        </button>
                        <button onClick={() => edit(row)}
                          className="rounded-lg bg-track px-3.5 py-1.5 text-sm font-extrabold hover:brightness-95">
                          Edit
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <Pager page={page.quizzes} total={foundQuizzes.length} per={QUIZ_PAGE}
                onPage={(n) => setPage((p) => ({ ...p, quizzes: n }))} />
            </>
          )}

          {/* the latest few games under the quizzes, so how the last class went is
              on the first screen; the full history is one click away */}
          {foundGames.length > 0 && (
            <section className="mt-8">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[.1em] text-muted">Past games</h2>
                {foundGames.length > PREVIEW && (
                  <button onClick={() => setTab('games')}
                    className="text-sm font-semibold text-anchor hover:underline">
                    See all {foundGames.length} →
                  </button>
                )}
              </div>
              {gameTable(foundGames.slice(0, PREVIEW))}
            </section>
          )}
        </>
      )}

      {data && tab === 'games' && (
        !games.length ? (
          <p className="rounded-2xl border border-dashed border-line px-8 py-12 text-center text-muted">
            Finished games land here, with how the class did and every download.
          </p>
        ) : !foundGames.length ? (
          <p className="py-10 text-center text-muted">No game matches “{q}”.</p>
        ) : (
          <>
            {gameTable(pageOf(foundGames, page.games, GAME_PAGE))}
            <Pager page={page.games} total={foundGames.length} per={GAME_PAGE}
              onPage={(n) => setPage((p) => ({ ...p, games: n }))} />
          </>
        )
      )}
    </div>
  )
}

const QUIZ_PAGE = 9     // three rows of cards
const GAME_PAGE = 10
const PREVIEW = 3       // games shown under the quiz cards
const GAME_COLS = 'grid grid-cols-[minmax(0,2fr)_5rem_6rem_minmax(6rem,1fr)_2rem] items-center gap-3'
// clamped, so deleting the last quiz on the last page lands on the page before
const pageOf = (rows, n, per) => {
  const at = Math.max(0, Math.min(n, Math.ceil(rows.length / per) - 1))
  return rows.slice(at * per, at * per + per)
}
const day = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/* Prev / next and where you are. Hidden when everything fits on one page. */
function Pager({ page, total, per, onPage }) {
  const pages = Math.ceil(total / per)
  if (pages <= 1) return null
  // a search can shrink the list under the page you were on
  const at = Math.min(page, pages - 1)
  const btn = `rounded-lg px-3 py-1.5 text-sm font-semibold enabled:hover:bg-track
    disabled:opacity-35`
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-center gap-2">
      <button className={btn} disabled={at === 0} onClick={() => onPage(at - 1)}>← Prev</button>
      <span className="px-2 text-sm font-semibold tabular-nums text-muted">
        Page {at + 1} of {pages}
      </span>
      <button className={btn} disabled={at >= pages - 1} onClick={() => onPage(at + 1)}>Next →</button>
    </nav>
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
        and <code className="rounded bg-track px-1">*</code> marks the correct one. Mark more than
        one <code className="rounded bg-track px-1">*</code> and it becomes a
        &ldquo;select all that apply&rdquo; question.
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
    initial.questions.map((q) => ({
      ...q, timer: String(q.timer ?? 20),
      // a saved quiz carries only the half its type uses; fill the other so
      // switching type in the builder has something to edit
      options: q.options?.length ? q.options : ['', ''], correct: q.correct ?? 0,
      min: String(q.min ?? 1), max: String(q.max ?? 10),
    })))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')      // '' | 'save' | 'start' — which button is in flight
  const [bulk, setBulk] = useState(false)
  const [mode, setMode] = useState(() => ({ ...DEFAULT_MODE, ...(initial.mode || {}) }))
  // open for a new quiz, where the type is the first thing to decide; a saved
  // quiz opens on its one-line summary
  const [showModes, setShowModes] = useState(() => !initial.questions.some((q) => q.text?.trim()))
  const numeric = mode.grading === 'average'
  const num = (v) => (String(v).trim() === '' ? null : Number(v))
  const readSecs = Number(localStorage.getItem(READ_KEY) || 0)
  const patch = (qi, fn) => setQuestions((qs) => qs.map((q, i) => (i === qi ? fn(q) : q)))

  /* run=false saves the quiz and drops back to the dashboard without starting a
     room; onCreated(null) already routes there. */
  const create = async (run) => {
    if (!title.trim()) { setErr('Give the quiz a name so you can find it again'); return }
    // all-or-nothing needs something to match: a graded select-all with no tick
    // could never be answered right
    const unkeyed = settle(mode).grading === 'graded'
      ? questions.findIndex((q) => q.multi && q.text.trim() && !asList(q.correct).length) : -1
    if (unkeyed >= 0) { setErr(`Q${unkeyed + 1} needs at least one correct answer ticked`); return }
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
          // a live average has no options: the blank pair a new question starts
          // with would otherwise trip "the option marked correct is blank"
          options: numeric ? [] : q.options,
          correct: numeric ? null : q.correct,
          multi: !numeric && !!q.multi,
          min: numeric ? num(q.min) : null, max: numeric ? num(q.max) : null,
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
          {/* the text format is options-shaped; a live average has none to paste */}
          {!numeric && (
            <button onClick={() => setBulk((b) => !b)}
              className="rounded-xl bg-track px-4 py-2 text-sm font-extrabold hover:brightness-95">
              {questions.some((q) => q.text.trim()) ? 'Edit all as text' : 'Paste questions'}
            </button>
          )}
          <button onClick={onCancel}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:text-ink">
            Cancel
          </button>
        </div>
      </div>

      {/* How this quiz runs. The type comes first because it decides which of the
          other settings still mean anything; those it settles drop out of view. */}
      <section className="mb-8 border-b border-line pb-6">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-[.1em] text-muted">
            How this quiz runs
          </h3>
          <button onClick={() => setShowModes((s) => !s)}
            className="text-sm font-semibold text-anchor hover:underline">
            {showModes ? 'Done' : 'Change'}
          </button>
        </div>

        {!showModes && (
          <p className="mt-2 text-sm font-semibold text-muted">{summarise(settle(mode), capacity)}</p>
        )}

        {showModes && (
          <div className="mt-4 flex flex-col gap-6">
            <div role="radiogroup" aria-label="Kind of quiz"
              className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 md:grid-cols-4">
              {TYPES.map(([v, name, hint]) => {
                const on = mode.grading === v
                return (
                  <button key={v} type="button" role="radio" aria-checked={on}
                    onClick={() => setMode((m) => ({ ...m, grading: v }))}
                    className={`flex flex-col gap-1 rounded-2xl border-2 p-4 text-left transition
                      ${on ? 'border-anchor bg-anchor/5' : 'border-line hover:border-muted/40'}`}>
                    <span className={`font-extrabold ${on ? 'text-anchor' : 'text-ink'}`}>{name}</span>
                    <span className="text-sm leading-snug text-muted">{hint}</span>
                  </button>
                )
              })}
            </div>

            <div className="grid grid-cols-1 items-center gap-x-6 gap-y-3
              sm:grid-cols-[10rem_minmax(0,1fr)]">
              {SWITCHES.filter(([k]) => !settled(mode)[k]).map(([key, label, opts]) => (
                <Fragment key={key}>
                  <span className="text-sm font-semibold text-ink">{label}</span>
                  <Segmented label={label} value={settle(mode)[key]}
                    // absolute speed needs a fixed window, which an open question has not
                    options={key === 'scoring' && mode.timing === 'open'
                      ? opts.filter(([v]) => v !== 'absolute') : opts}
                    onChange={(v) => setMode((m) => ({ ...m, [key]: v }))} />
                </Fragment>
              ))}
              <label htmlFor="capacity" className="text-sm font-semibold text-ink">Room holds</label>
              <span className="flex items-center gap-2 text-sm font-semibold text-muted">
                <input id="capacity" type="number" min="1" value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                  className="w-24 rounded-lg border-2 border-line px-2 py-1.5 text-ink
                    outline-none focus:border-anchor" />
                players — leave room for stragglers
              </span>
            </div>
          </div>
        )}
      </section>

      {bulk && (
        <BulkImport existing={questions} graded={mode.grading === 'graded'}
          onClose={() => setBulk(false)}
          onLoad={(qs) => {
            setQuestions(qs.map((q) => ({ ...q, timer: String(q.timer), min: '1', max: '10' })))
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

            {numeric ? (
              /* inclusive both ends — the server enforces the same range on every answer */
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-peri px-4 py-3
                text-sm font-semibold text-peri-ink">
                Students answer a whole number from
                {['min', 'max'].map((k, i) => (
                  <Fragment key={k}>
                    {i > 0 && <span>to</span>}
                    <input type="number" step="1" value={q[k]}
                      aria-label={`${k === 'min' ? 'Lowest' : 'Highest'} answer for question ${qi + 1}`}
                      onChange={(e) => patch(qi, (x) => ({ ...x, [k]: e.target.value }))}
                      className="w-24 rounded-lg border-2 border-transparent bg-canvas px-2 py-1.5
                        text-center text-ink outline-none focus:border-anchor" />
                  </Fragment>
                ))}
              </div>
            ) : (
            <div className="flex flex-col gap-2">
              {q.options.map((opt, oi) => {
                const t = tone(oi)
                return (
                  <div key={oi} className={`flex items-center gap-3 rounded-xl ${t.fill} px-3 py-2`}>
                    {/* a select-all question ticks every right option */}
                    <input type={q.multi ? 'checkbox' : 'radio'} name={`c${qi}`}
                      checked={q.multi ? asList(q.correct).includes(oi) : q.correct === oi}
                      onChange={() => patch(qi, (x) => ({
                        ...x,
                        correct: !x.multi ? oi : asList(x.correct).includes(oi)
                          ? asList(x.correct).filter((c) => c !== oi)
                          : [...asList(x.correct), oi].sort((a, b) => a - b),
                      }))}
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
                          correct: x.multi
                            ? asList(x.correct).filter((c) => c !== oi).map((c) => (c > oi ? c - 1 : c))
                            : x.correct >= oi && x.correct > 0 ? x.correct - 1 : x.correct,
                        }))}
                        className={`font-bold opacity-50 hover:opacity-100 ${t.ink}`}>✕</button>
                    )}
                  </div>
                )
              })}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {q.options.length < 6 && (
                  <button onClick={() => patch(qi, (x) => ({ ...x, options: [...x.options, ''] }))}
                    className="text-sm font-semibold text-anchor hover:underline">
                    + Add option
                  </button>
                )}
                {/* switching keeps what was marked: one becomes a list, a list
                    keeps its first */}
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-muted">
                  <input type="checkbox" checked={!!q.multi} className="size-4 accent-anchor"
                    onChange={(e) => patch(qi, (x) => ({
                      ...x, multi: e.target.checked,
                      correct: e.target.checked ? asList(x.correct) : (asList(x.correct)[0] ?? 0),
                    }))} />
                  Multiple answers · select all that apply
                </label>
              </div>
            </div>
            )}
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
function Host({ token, code, onExit, onGone, onAuthFail }) {
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
  // a host setting, not something for the room to read off the projector
  const [editBase, setEditBase] = useState(false)
  const cleanBase = base.trim().replace(/\/+$/, '') || location.origin
  const joinUrl = `${cleanBase}/join/${code}`
  let publicHost = location.host
  try { publicHost = new URL(cleanBase).host } catch { /* mid-typing, keep the last good one */ }

  useEffect(() => {
    QRCode.toDataURL(joinUrl, { margin: 1, width: 640, color: { dark: '#1B2333', light: '#FFFFFF' } })
      .then(setQr).catch(() => setQr(''))
  }, [joinUrl])

  const onMsg = useCallback((m) => {
    switch (m.type) {
      // a dead link (reaped room, typo'd code) — replace it so Back does not loop
      case 'error': if (m.msg === 'Room not found') onGone(); break
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
        // and a live average's running numbers, the same way
        if (m.spread) setQuestion((q) => (q ? { ...q, spread: m.spread } : q))
        break
      // one payload drives both insight screens; the host steps through them
      case 'results': setResults(m); setPhase('bars'); break
      case 'game_over': setOver(m); setPhase('over'); break
      default: break
    }
  }, [onGone])

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
  // Any new screen means the press landed. Clearing only on new results left
  // Next's press armed into the next question, so an open question's Finish
  // (and a live poll's Close) came up greyed from Q2 on until a refresh.
  useEffect(() => { setAdvancing(false) }, [results, over, phase])

  // Ends it for everyone, from any screen. Revealed questions stand and are
  // archived with their report; a question still open is dropped unscored.
  const quit = () => {
    if (!confirm('End this quiz for everyone? Questions already shown keep their scores; '
      + 'anything still open is dropped.')) return
    send({ type: 'quit' })
  }

  return (
    <Screen>
      {/* the mark links home: the dashboard, where this room stays listed under
          "Running now" with Resume — same as the lobby's Back */}
      <JoinStrip code={code} right={players} host={publicHost} action={phase !== 'over' && (
        <button onClick={quit} disabled={status !== 'open'}
          className="rounded-lg px-2 py-1 font-semibold text-muted hover:bg-rose
            hover:text-rose-ink disabled:opacity-40">
          End quiz
        </button>
      )} />

      {/* The same screen opens the quiz and gates every question after it: the
          room code and a QR big enough to scan from a seat, who is in, and one
          button that does not move until the host presses it. Between questions
          that is the whole point — latecomers get a door, and nobody is halfway
          through reading Q4 when it appears. */}
      {(phase === 'lobby' || phase === 'waiting') && (
        <div className="grid flex-1 grid-cols-1 items-stretch gap-6 md:grid-cols-[minmax(0,40%)_1fr]">
          <div className="flex min-h-0 flex-col items-center justify-center gap-3 rounded-3xl bg-track p-6">
            <span className="text-[clamp(1.8rem,4.4vw,3.8rem)] font-extrabold tracking-[.12em] text-anchor">
              {code}
            </span>
            {/* sized against the screen height too, so the code and link still fit
                under it on a short projector */}
            {qr && <img src={qr} alt={`QR code to join room ${code}`}
              className="w-[min(84%,48vh)] rounded-2xl bg-white p-2" />}
            <button onClick={copyLink} title="Copy join link"
              className={`max-w-full truncate text-xs hover:text-anchor
                ${copied ? 'font-bold text-mint-ink' : 'text-muted'}`}>
              {copied ? 'Copied ✓' : joinUrl}
            </button>
            {editBase ? (
              <>
                <input value={base} aria-label="Public address players use" autoFocus
                  placeholder="https://your-tunnel.ngrok-free.app"
                  onChange={(e) => {
                    setBase(e.target.value)
                    localStorage.setItem(BASE_KEY, e.target.value)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && setEditBase(false)}
                  className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-center
                    text-xs outline-none placeholder:text-muted/50 focus:border-anchor" />
                <button onClick={() => setEditBase(false)}
                  className="text-[11px] font-semibold text-anchor hover:underline">
                  Done — players join through this address
                </button>
              </>
            ) : (
              <button onClick={() => setEditBase(true)}
                className="text-[11px] font-semibold text-muted hover:text-anchor">
                Joining through a tunnel? Change address…
              </button>
            )}
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
          {question.multi && (
            <p className="-mt-2 flex-none text-[clamp(.9rem,1.8vw,1.5rem)] font-semibold text-anchor">
              Select all that apply
            </p>
          )}
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
              {question.range ? (
                <AverageMeter spread={question.spread} range={question.range} />
              ) : question.tally ? (
                <PollColumns tally={question.tally} options={question.options}
                  of={question.multi ? progress.answered : undefined} />
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
                      {question.tally || question.range ? 'Close poll →' : 'Finish question →'}
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
          {/* the line the host reads out, so it sits up here and large. The answer
              itself is already the one bar left in colour — not repeated here. */}
          {(() => {
            const answered = results.spread?.count ?? results.answered
              ?? results.tally.reduce((a, b) => a + b, 0)
            const of = results.total_players
            // got_it, not one bar's count: on a select-all question nobody's
            // single option says who got the whole set right
            const got = results.correct != null ? (results.got_it ?? results.tally[results.correct]) : null
            return (
              <p className="flex-none text-[clamp(1.1rem,2.6vw,2.4rem)] font-extrabold tabular-nums">
                {got != null ? <>{got} of {of} got it</> : <>{answered} of {of} answered</>}
                {got != null && of > 0 && (
                  <span className="text-[.7em] font-semibold text-muted"> · {Math.round((got / of) * 100)}%</span>
                )}
              </p>
            )
          })()}
          {/* keep the snippet on screen while the room discusses the answer */}
          <QuestionMedia code={results.code} image={results.image} className="max-h-[26vh]" />
          {/* a live poll settles into the columns it just filled, rather than
              swapping to a different chart of the same numbers */}
          {results.spread
            ? <AverageMeter spread={results.spread} range={results.range} done />
            : results.poll || question?.tally
            ? <PollColumns tally={results.tally} options={results.options}
                of={results.multi ? results.answered : undefined} />
            : <ResultBars tally={results.tally} options={results.options}
                correct={results.correct} of={results.answered} />}
          <div className="flex flex-none items-center justify-between gap-4">
            <span />
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
                  {over.quit ? 'Quiz ended' : "That's the last question"}
                </div>
                <p className="text-[clamp(1rem,2vw,1.6rem)] font-semibold text-muted">
                  {over.total_players} took part
                </p>
              </div>
            )}
          <div className="flex flex-none items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2">
            {/* by rank, not by index — a tie on the podium makes them differ,
                and slicing by index would list a medallist again as 4th */}
            {(over.leaderboard || []).filter((p) => (p.rank ?? 99) > 3).slice(0, 5).map((p) => (
              <span key={p.name} className="rounded-full bg-track px-4 py-1.5
                text-[clamp(.7rem,1.2vw,1rem)] font-semibold">
                {p.rank} · {p.name.split('@')[0]}{' '}
                <b className="font-extrabold tabular-nums">{p.score}</b>
              </span>
            ))}
          </div>
          {/* The downloads are the host's, not the room's — on the projector they
              sat between the 4th and 5th place names. One quiet menu instead;
              a native <details>, so it needs no open/close state of its own. */}
          <div className="flex flex-none items-center gap-2">
            {/* ended before a single question was revealed: nothing to download */}
            {(!over.quit || over.asked > 0) && (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-xl border border-line px-4 py-3
                text-sm font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                Downloads ▾
              </summary>
              <div className="absolute bottom-full right-0 z-20 mb-2 flex w-60 flex-col rounded-xl
                border border-line bg-canvas p-1 shadow-lg">
                {['report', 'scores', 'responses', 'questions'].map((k, i) => (
                  <button key={k} onClick={() => grab(k)}
                    className={`rounded-lg px-3 py-2 text-left text-sm hover:bg-track
                      ${i === 0 ? 'font-extrabold' : 'font-semibold'}`}>
                    {i === 0 ? 'Full report' : EXPORTS[k].label}
                  </button>
                ))}
              </div>
            </details>
            )}
            <Button onClick={onExit}>Done</Button>
          </div>
          </div>
        </>
      )}

      {status !== 'open' && (
        <p className="flex-none text-center text-sm font-semibold text-peach-ink">Reconnecting…</p>
      )}
    </Screen>
  )
}


# ReHit
Recall - Hit - Repeat

Real-time, Kahoot-style quiz. FastAPI + WebSockets backend, React + Tailwind
frontend. No database — state is in memory.

## Run (one command)

```bash
docker compose up --build
```

Open **http://localhost:8000** — admin login is `Admin` / `AUACAD@2026`
(set via `ADMIN_PASS` in `docker-compose.yml`). Players join at the `/join/<CODE>`
link the host console shows (with QR).

## Flow

1. Admin logs in → **dashboard** lists **your saved quizzes**, any game still
   running (which you can resume), and recent finished games → **New quiz**
   builds one (name, capacity, per-question timer, correct option). Finish with
   **Save for later** — it lands on the dashboard and starts nothing — or
   **Save & start now**, which also opens a room. Building a quiz never commits
   you to hosting it, so you can prep the night before and run it in class.
2. Host console shows the room code, join link + QR, and a live lobby where
   players bubble in as they join.
3. Players open the link, enter a unique email, land in the lobby. **Latecomers
   are not locked out** — the link works for the whole quiz, and someone joining
   while a question is live drops straight into it with the time that is left.
   They score from where they walked in: questions asked before they arrived are
   worth nothing to them, so there is still one leaderboard under one set of
   rules. Their CSV row leaves those questions blank rather than marking them
   wrong, so you can tell "arrived late" from "got it wrong". Only the room's
   capacity still applies, and a finished quiz can no longer be joined.
4. Host clicks **Start**. Each question appears **on its own first** for a few
   seconds' reading time — no options, nothing being timed — then the options
   open and the answer clock starts. A 25s question runs as 5s reading + 20s
   answering, and **scoring is measured from the moment the options appear**, so
   reading time never costs anyone points. The question closes when the answer
   clock ends **or** everyone has answered.
5. After each question the host steps through two screens, at their own pace:
   1. **Results** — every option with the percentage that chose it, correct
      answer highlighted. Press **Show leaderboard →**.
   2. **Leaderboard** — top 15 from rank 1, with **animated overtakes** and
      movement arrows. The join QR sits in the corner here, since this is the
      last screen before the next question and latecomers can still scan in.
      Press **Next question →** (or **← Back to results**).

   Nothing is on a timer, so you can talk through each screen for as long as you
   like.
6. The host presses **Show final results** after the last question: podium +
   **Download results CSV** (score + per-question answer / correct / time).
   Finished games are archived, so the CSV stays available from the dashboard
   afterwards.

**Refreshing is safe.** Admin sessions are signed tokens rather than server-side
state, held in `localStorage` — so a reload, a new tab, or a **server restart**
all keep you logged in and drop you back into the room you were hosting. A player
rejoins their seat with their score and, mid-question, their locked-in answer.
Reconnecting with the same email takes over the old session rather than being
refused — last device in wins.

## How a quiz runs — six switches

Under the quiz name in the builder is one line describing how this quiz behaves,
and a **Change** link. There are no modes, only six independent switches; a
"feedback poll" is just several of them set together. The default of every one is
what the app has always done, so ignoring this entirely changes nothing.

| Switch | Options |
|---|---|
| **Players join by** | their email · a name they choose · nothing (anonymous) |
| **Answers are** | graded · a poll, with no right answer |
| **Each question** | runs on its timer · stays open until you close it |
| **Points** | faster is worth more · faster than the rest of the room · flat · none |
| **After each one** | show the correct answer · keep it hidden |
| **Leaderboard** | after every question · only at the end · never |

Three of these settle themselves, because the alternative is meaningless: a poll
has nothing to score, no scoring has nothing to rank, and a question with no clock
cannot measure absolute speed (it uses *faster than the room* instead). Switches
that cannot matter grey out rather than vanish.

**Joining by name** requires it to be unused in that room — a clash is refused so
you never get two people called "Priya" in one export. Refreshing still returns
you to your own seat and score; the browser remembers which chair is yours, so
you never have to retype your way back in. **Anonymous** asks for nothing at all
and hands out a readable name like *Swift Otter*, so the lobby and leaderboard
still work as something to watch.

**Stays open until you close it** replaces the countdown with a stopwatch counting
*up*, and the question runs until you press **Finish question**. It does not close
itself when everyone has answered — the point is to let a discussion breathe. Pair
it with *faster than the rest of the room*, which scores on the gap between the
first answer in and the moment you closed it.

## Bulk-adding questions

In the builder, hit **Paste questions**. One question per block, options start
with `-`, and `*` marks the correct one:

```
Which sorting algorithm has O(n log n) worst case? [20]
* Merge sort
- Quick sort
- Bubble sort

Capital of France?
* Paris
- Rome
```

A question can also carry an **optional code snippet** — fence it in ``` before
the options. Everything inside the fence is taken verbatim, so a line starting
with `-` or `*` stays code instead of becoming an option:

````
What does this print? [30]
```
xs = [1, 2, 3]
print(xs[-1])
```
* 3
- 1
````

An **optional image** goes on its own line as `!https://…` (markdown
`![alt](url)` also works). Images are referenced by URL — there is no upload.

`[20]` after a question sets its timer in seconds (optional, defaults to 20).
Blank lines between questions are optional. Problems are reported per line
(`Line 5 — "Bad?" has no correct answer`) and valid questions still import, so
you can fix and re-paste just the broken ones.

**JSON also works** if the input starts with `[` or `{` — handy for generating
questions from a script:

```json
[{ "text": "Capital of France?", "options": ["Paris", "Rome"], "correct": 0, "timer": 15 }]
```

`correct` accepts an index or the answer's own text; `code` and `image` are
optional. Imported questions land in the builder for review and editing before
you create the room.

In the builder itself, each question has **+ Add code snippet or image** for the
same two optional fields.

## Getting a class connected

**Do not put a whole class through a free ngrok tunnel.** ngrok's free plan
rate-limits connections per minute, and a class does not trickle in — everyone
opens the link within the same thirty seconds. Seventy students is ~70 page
loads plus 70 WebSockets through one tunnel at once, which trips the limit; the
tunnel then starts refusing everything, including the join page itself
("site unavailable"), and students who were already in get dropped too. This is
what happened in the first pilot: it took ~61 people and then the link died.

In preference order:

1. **Same wifi, no tunnel at all.** Run the app on your laptop and have students
   go to `http://<your-laptop-ip>:8000` (`hostname -I` gives the address). No
   tunnel, no rate limit, lowest latency, nothing to break. This is the right
   answer for a room where everyone is on campus wifi.
2. **Cloudflare Tunnel** — free, and it does not rate-limit connections:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
3. **A paid ngrok plan**, if you already have one.

Check your **room capacity** too — the number set in the builder is a hard cap,
and the person who trips it sees "Room is full" on the join screen — that check
applies to latecomers mid-quiz too, so leave headroom for stragglers. Set it
comfortably above your class size.

### Pre-flight, ten minutes before class

1. `docker compose ps` — is it actually **running**? A stopped container is the
   dumbest way to lose a class.
2. `docker compose exec app python /srv/test_resilience.py` — all checks pass.
3. `hostname -I` — the laptop's address can change on DHCP; confirm today's.
4. **Open the join link on one phone, over the wifi the students will use.** This
   is the whole decision. Many campus and guest networks run *client isolation*,
   which blocks phone-to-laptop traffic and makes LAN hosting impossible no
   matter how the app is configured. If that one phone gets in, all of them will;
   if it doesn't, fall back to a Cloudflare tunnel.
5. Stop the laptop sleeping (`caffeinate`, or just disable suspend).

### Running it over ngrok

```bash
ngrok http 8000
```

**Open the admin console through the ngrok URL** and everything just works — the
join link, the QR and the WebSockets all follow whatever address you loaded the
page from, so nothing needs configuring.

Only if you host the console on `localhost` while players come in over the tunnel
do you need the **Public address** field under the QR in the host lobby: paste
the ngrok URL there and the link and QR regenerate against it. It is remembered
for the next room.

CORS defaults to `*`; set `CORS_ORIGINS` to your tunnel URL if you want to lock
it down.

## Design

The visual language ("Presentation Pastel") is written down in
[DESIGN.md](DESIGN.md) — palette with verified contrast ratios, type scale,
component specs and motion timings. Tokens live in `frontend/src/index.css`
under `@theme`; components use the generated utilities, never raw hex.

Scoring is speed-based (fast correct ≈ 1000, slow correct ≈ 500, wrong 0);
equal scores **share a rank** rather than being separated. Ranks are dense, so
the board reads 1, 1, 2 with no gaps, and a two-way tie for first means there is
no second place — both names share the top step of the podium and the confetti.
Cumulative answer time still orders people *within* a tie, so the board is
stable, but it no longer decides who beat whom.

## Local dev (hot reload)

```bash
# backend
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload
# frontend (separate terminal) — proxies /api and /ws to :8000
cd frontend && npm install && npm run dev
```
Dev UI runs on http://localhost:5173.

## Tests

```bash
cd backend  && python3 test_quiz.py  # engine: scoring, ranking, refresh takeover, deltas, CSV, history
cd frontend && npm test              # bulk-import parser (node's built-in runner, no framework)

# resilience: needs a running server, checks the things that broke the first pilot
docker compose exec app python /srv/test_resilience.py
```

`test_resilience.py` covers the failure modes a flaky classroom network actually
produces — gzip on the bundle, heartbeat replies, a mid-question disconnect not
ending the question for everyone else, and an answer sent after a reconnect still
scoring.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `ADMIN_USER` / `ADMIN_PASS` | `Admin` / `AUACAD@2026` | admin credentials. Changing the password also invalidates every existing admin session, since the session signing key derives from it. |
| `SECRET_KEY` | derived from the credentials | signs admin sessions; change it to invalidate all sessions |
| `SESSION_SECS` | `43200` | how long an admin stays logged in (12h) |
| `READ_SECS` | `5` | question shown alone before the options open; trimmed automatically so short questions keep at least 1s to answer |
| `ADVANCE_TIMEOUT_SECS` | `900` | backstop only — if the host abandons the game, the room continues after this so it can finish and be reaped |
| `ROOM_TTL_SECS` | `3600` | reap ended / abandoned rooms from memory after this |
| `DB_PATH` | `quiz.db` | sqlite file holding saved quizzes and game history |
| `HISTORY_LIMIT` | `200` | finished games kept (and listed); older ones roll off with their CSV |
| `SAVED_QUIZZES` | `200` | saved quiz definitions kept; oldest-used roll off, **taking their questions with them** |
| `MAX_QUESTIONS` / `MAX_OPTIONS` / `MAX_CAPACITY` / `MAX_TIMER` | `50` / `6` / `1000` / `300` | validation bounds |
| `CORS_ORIGINS` | `*` | comma-separated allowed origins |

## The dashboard

One list, newest first. Every quiz you build is **kept automatically** under its
name — both builder buttons save, and neither needs a separate save step. Each
row shows the name, question count,
when it last ran, how many played and who won, with:

- **Re-run** — starts a fresh room from the same questions
- **CSV** — results of the last time it ran
- **✕** — forget the quiz

Re-running updates that same row rather than adding another, so the list stays
one-row-per-quiz. Re-saving the same name replaces it, so a quiz has one current
version; rename it and you get a separate quiz.

Rows from games whose quiz has rolled off (or predates names) still offer their
CSV — they just have nothing left to re-run.

Rooms that are live right now appear above under **Running now**, with **Resume**
instead, so you can get back to a console you navigated away from.

## Storage

Live games are in memory. sqlite (`backend/app/store.py` — two tables, no ORM)
holds the things worth keeping: **saved quizzes** and **finished games**, so the
dashboard and old CSV downloads survive a restart. Compose mounts a `quiz-data`
volume for the database.

Both tables **roll over**: only the 200 most recent are kept (`SAVED_QUIZZES` and
`HISTORY_LIMIT`), so the file never grows without bound.

Rolling off is a real delete, and quietly asymmetric on the dashboard: a game
rolling off history takes its CSV with it, and a **quiz** rolling off takes its
questions. The dashboard row survives either way — so the quiz still *looks*
listed and its CSV still downloads — but **Re-run** disappears, because there is
nothing left to run. These limits were 10 each, which is low enough to lose a
quiz you were still using; keep them well above however many you build.

## Scaling note

Live state is in-process, so run **one** worker (the default). One asyncio
process handles thousands of concurrent WebSockets fine — scale vertically.
Horizontal scaling across processes/machines would need shared live state (e.g.
Redis) + pub/sub fan-out; deliberately out of scope here.
```

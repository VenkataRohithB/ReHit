/** Fold an incoming `question` payload into what the console is already holding.
 *
 *  A merge rather than a replace, because the reading-phase payload deliberately
 *  carries no options and the console keeps per-question extras (a live poll's
 *  tally) that arrive on separate messages.
 *
 *  The catch, and the reason this is its own tested function: the server omits
 *  timing keys rather than nulling them, so what applies is expressed by a key
 *  being absent. An open question sends `elapsed` and no `remaining`; a timed one
 *  sends `remaining` + `window` and no `elapsed`. A spread cannot unset a key the
 *  new payload leaves out, so a stale `remaining` survived from the reading phase
 *  into the answering phase and put a countdown on a question the host is meant
 *  to close by hand. Timing is taken from the incoming payload alone.
 */
const TIMING = ['remaining', 'window', 'elapsed']

export function mergeQuestion(current, incoming) {
  if (!current || current.index !== incoming.index) return incoming
  const kept = { ...current }
  for (const k of TIMING) delete kept[k]
  return { ...kept, ...incoming }
}

/** True when this question runs on a clock. An open question has no deadline to
 *  count down to, so the console shows a stopwatch and a close button instead. */
export const isTimed = (q) => q != null && q.remaining != null

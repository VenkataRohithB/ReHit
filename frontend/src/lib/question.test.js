import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeQuestion, isTimed } from './question.js'

// the two shapes the server actually sends, per Room.question_msg
const reading = (i = 0) => ({
  type: 'question', index: i, total: 2, text: 'Q', phase: 'reading',
  remaining: 5, window: 5,
})
const openAnswering = (i = 0) => ({
  type: 'question', index: i, total: 2, text: 'Q', phase: 'answering',
  options: ['a', 'b'], elapsed: 0, answered: 0, players: 3,
})
const timedAnswering = (i = 0) => ({
  type: 'question', index: i, total: 2, text: 'Q', phase: 'answering',
  options: ['a', 'b'], remaining: 15, window: 15, answered: 0, players: 3,
})

test('an open question does not inherit the reading phase countdown', () => {
  // the live bug: "stays open until I close it" showed a timer anyway, and a
  // reload fixed it — because a reload rebuilt the state from one payload
  const merged = mergeQuestion(reading(), openAnswering())
  assert.equal(merged.remaining, undefined, 'a countdown must not survive')
  assert.equal(merged.window, undefined)
  assert.equal(merged.elapsed, 0)
  assert.equal(isTimed(merged), false, 'the console must show the close button')
  assert.deepEqual(merged.options, ['a', 'b'], 'and still gain the options')
})

test('a timed question keeps its countdown', () => {
  const merged = mergeQuestion(reading(), timedAnswering())
  assert.equal(merged.remaining, 15, 'the answering window, not the reading one')
  assert.equal(merged.window, 15)
  assert.equal(merged.elapsed, undefined)
  assert.equal(isTimed(merged), true)
})

test('a new question replaces rather than merges', () => {
  const stale = { ...timedAnswering(0), tally: [3, 1] }
  const merged = mergeQuestion(stale, openAnswering(1))
  assert.equal(merged.index, 1)
  assert.equal(merged.remaining, undefined, 'no bleed from the previous question')
  assert.equal(merged.tally, undefined, 'nor its poll counts')
})

test('extras picked up mid-question survive the same-index merge', () => {
  // a live poll's tally arrives on `progress`, not on `question`
  const held = { ...openAnswering(), tally: [2, 0] }
  const merged = mergeQuestion(held, { ...openAnswering(), elapsed: 9 })
  assert.deepEqual(merged.tally, [2, 0])
  assert.equal(merged.elapsed, 9)
})

test('isTimed reads absence, not falsiness', () => {
  // remaining hits 0 on a real countdown; that is still a timed question
  assert.equal(isTimed({ remaining: 0 }), true)
  assert.equal(isTimed({ elapsed: 12 }), false)
  assert.equal(isTimed(null), false)
})

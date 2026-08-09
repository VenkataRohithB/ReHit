/* Parser self-check — no framework, node's built-in runner:
     cd frontend && npm test                (or: node --test src/lib) */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuiz, EXAMPLE, DEFAULT_TIMER } from './parseQuiz.js'

test('parses the documented example', () => {
  const { questions, errors } = parseQuiz(EXAMPLE)
  assert.deepEqual(errors, [])
  assert.equal(questions.length, 3)
  assert.deepEqual(questions[0], {
    text: 'Which sorting algorithm has O(n log n) worst case?',
    options: ['Merge sort', 'Quick sort', 'Bubble sort', 'Insertion sort'],
    correct: 0, timer: 20,
  })
  assert.equal(questions[0].code, undefined, 'code is omitted when unused')
  assert.equal(questions[1].code, 'xs = [1, 2, 3]\nxs = [x * 2 for x in xs]\nprint(xs[-1])')
  assert.equal(questions[1].correct, 0)
  assert.equal(questions[2].correct, 1, 'correct index follows the * marker, not position')
  assert.equal(questions[2].timer, 15)
})

test('code lines that look like options are kept as code', () => {
  const src = [
    'What is the result?',
    '```',
    '- not an option',
    '* also not an option',
    '  indented = True',
    '```',
    '* Right',
    '- Wrong',
  ].join('\n')
  const { questions, errors } = parseQuiz(src)
  assert.deepEqual(errors, [])
  assert.equal(questions.length, 1)
  assert.deepEqual(questions[0].options, ['Right', 'Wrong'], 'only real options are options')
  assert.equal(questions[0].code, '- not an option\n* also not an option\n  indented = True')
  assert.equal(questions[0].correct, 0)
})

test('preserves indentation inside a code block', () => {
  const { questions } = parseQuiz('Q?\n```\ndef f():\n    return 1\n```\n* a\n- b')
  assert.equal(questions[0].code, 'def f():\n    return 1')
})

test('an unclosed code block is reported, not swallowed', () => {
  const { errors } = parseQuiz('Q?\n```\nx = 1\n* a\n- b')
  assert.equal(errors[0].line, 2)
  assert.match(errors[0].msg, /never closed/)
})

test('code must come before the options', () => {
  const { errors } = parseQuiz('Q?\n* a\n- b\n```\nx = 1\n```')
  assert.match(errors[0].msg, /before the options/)
})

test('reads an image line, plain or markdown', () => {
  const plain = parseQuiz('Q?\n!https://example.com/a.png\n* a\n- b')
  assert.deepEqual(plain.errors, [])
  assert.equal(plain.questions[0].image, 'https://example.com/a.png')

  const md = parseQuiz('Q?\n![a chart](https://example.com/b.jpg)\n* a\n- b')
  assert.deepEqual(md.errors, [])
  assert.equal(md.questions[0].image, 'https://example.com/b.jpg')
})

test('JSON carries code and image through', () => {
  const { questions, errors } = parseQuiz(JSON.stringify([
    { text: 'Q?', options: ['a', 'b'], correct: 0, code: 'print(1)\n', image: 'https://x.dev/i.png' },
  ]))
  assert.deepEqual(errors, [])
  assert.equal(questions[0].code, 'print(1)')
  assert.equal(questions[0].image, 'https://x.dev/i.png')
})

test('rejects a non-web image URL', () => {
  const { errors } = parseQuiz(JSON.stringify([
    { text: 'Q?', options: ['a', 'b'], correct: 0, image: 'javascript:alert(1)' },
  ]))
  assert.match(errors[0].msg, /http:\/\/ or https:\/\//)
})

test('questions need no blank line between them', () => {
  const { questions, errors } = parseQuiz('Q one?\n* a\n- b\nQ two?\n* c\n- d')
  assert.deepEqual(errors, [])
  assert.equal(questions.length, 2)
  assert.equal(questions[1].text, 'Q two?')
})

test('tolerates CRLF, blank lines and loose spacing', () => {
  const { questions, errors } = parseQuiz('  Q?  [30]\r\n\r\n  *Paris\r\n-   Rome  \r\n')
  assert.deepEqual(errors, [])
  assert.deepEqual(questions[0], { text: 'Q?', options: ['Paris', 'Rome'], correct: 0, timer: 30 })
})

test('reports the line number for a question with no correct answer', () => {
  const { questions, errors } = parseQuiz('Good?\n* a\n- b\n\nBad?\n- x\n- y')
  assert.equal(questions.length, 1, 'the valid question is still imported')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 5)
  assert.match(errors[0].msg, /no correct answer/)
})

test('rejects two correct answers, too few options, and a bad timer', () => {
  assert.match(parseQuiz('Q?\n* a\n* b').errors[0].msg, /2 correct answers/)
  assert.match(parseQuiz('Q?\n* only').errors[0].msg, /at least 2 options/)
  assert.match(parseQuiz('Q? [900]\n* a\n- b').errors[0].msg, /1 to 300/)
  assert.match(parseQuiz('Q?\n* a\n- b\n- c\n- d\n- e\n- f\n- g').errors[0].msg, /maximum is 6/)
})

test('flags an option that appears before any question', () => {
  const { errors } = parseQuiz('- orphan\nQ?\n* a\n- b')
  assert.equal(errors[0].line, 1)
  assert.match(errors[0].msg, /before any question/)
})

test('caps at 50 questions and says so', () => {
  const many = Array.from({ length: 60 }, (_, i) => `Q${i}?\n* a\n- b`).join('\n\n')
  const { questions, errors } = parseQuiz(many)
  assert.equal(questions.length, 50)
  assert.match(errors.at(-1).msg, /first 50 of 60/)
})

test('accepts JSON, with correct as an index or as the answer text', () => {
  const byIndex = parseQuiz(JSON.stringify([
    { text: 'Q1?', options: ['a', 'b'], correct: 1, timer: 12 },
  ]))
  assert.deepEqual(byIndex.errors, [])
  assert.deepEqual(byIndex.questions[0], { text: 'Q1?', options: ['a', 'b'], correct: 1, timer: 12 })

  const byText = parseQuiz(JSON.stringify({
    questions: [{ question: 'Q2?', options: ['Paris', 'Rome'], answer: 'rome' }],
  }))
  assert.deepEqual(byText.errors, [])
  assert.equal(byText.questions[0].correct, 1, 'answer text matches case-insensitively')
  assert.equal(byText.questions[0].timer, DEFAULT_TIMER)
})

test('explains broken JSON instead of throwing', () => {
  const { questions, errors } = parseQuiz('[{"text": "oops"')
  assert.equal(questions.length, 0)
  assert.match(errors[0].msg, /not valid JSON/)
})

test('empty input asks for questions rather than erroring blankly', () => {
  assert.match(parseQuiz('   ').errors[0].msg, /paste some questions/i)
})

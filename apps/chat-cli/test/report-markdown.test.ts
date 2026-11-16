import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInline, parseMarkdown, plainText, splitTableRow } from '../src/report/markdown.ts'

test('parses headings, paragraphs, lists, tables, code, quotes and rules', () => {
  const blocks = parseMarkdown([
    '# Title',
    '',
    'First paragraph',
    'wrapped over two lines.',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '| A | B |',
    '|:--|--:|',
    '| 1 | 2 |',
    '',
    '> quoted',
    '> more',
    '',
    '```json',
    '{"a":1}',
    '```',
    '',
    '---',
  ].join('\n'))

  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'paragraph', 'list', 'list', 'table', 'quote', 'code', 'rule',
  ])
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Title' })
  assert.deepEqual(blocks[1], { type: 'paragraph', text: 'First paragraph wrapped over two lines.' })
  assert.deepEqual(blocks[2], { type: 'list', ordered: false, start: 1, items: ['one', 'two'] })
  assert.deepEqual(blocks[3], { type: 'list', ordered: true, start: 1, items: ['first', 'second'] })
  assert.deepEqual(blocks[4], {
    type: 'table', header: ['A', 'B'], rows: [['1', '2']], align: ['left', 'right'],
  })
  assert.deepEqual(blocks[5], { type: 'quote', text: 'quoted\nmore' })
  assert.deepEqual(blocks[6], { type: 'code', language: 'json', text: '{"a":1}' })
  assert.deepEqual(blocks[7], { type: 'rule' })
})

test('heading levels are capped and numbered lists keep their start', () => {
  const blocks = parseMarkdown('##### Deep\n\n3. three\n4. four')
  assert.deepEqual(blocks[0], { type: 'heading', level: 4, text: 'Deep' })
  assert.deepEqual(blocks[1], { type: 'list', ordered: true, start: 3, items: ['three', 'four'] })
})

test('a table without a separator row is plain text, not a table', () => {
  const blocks = parseMarkdown('| a | b |\n| c | d |')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'paragraph')
})

test('escaped pipes and inline code inside table cells survive', () => {
  assert.deepEqual(splitTableRow('| a \\| b | `x|y` |'), ['a | b', '`x|y`'])
})

test('an unclosed fence consumes the rest of the document', () => {
  const blocks = parseMarkdown('```\nline one\nline two')
  assert.deepEqual(blocks, [{ type: 'code', language: null, text: 'line one\nline two' }])
})

test('indented continuation lines belong to the list item', () => {
  const blocks = parseMarkdown('- first item\n  continued here\n- second')
  assert.deepEqual(blocks[0], { type: 'list', ordered: false, start: 1, items: ['first item continued here', 'second'] })
})

test('inline styles: bold, italic, code and escapes', () => {
  assert.deepEqual(parseInline('plain **bold** *italic* `code`'), [
    { text: 'plain ' }, { text: 'bold', bold: true }, { text: ' ' },
    { text: 'italic', italic: true }, { text: ' ' }, { text: 'code', code: true },
  ])
  assert.deepEqual(parseInline('a \\*literal\\* b'), [{ text: 'a *literal* b' }])
  assert.deepEqual(parseInline('2 * 3 = 6'), [{ text: '2 * 3 = 6' }], 'a spaced asterisk is not emphasis')
  assert.deepEqual(parseInline('**_both_**'), [{ text: 'both', bold: true, italic: true }])
  assert.deepEqual(parseInline('unbalanced **stays'), [{ text: 'unbalanced ' }, { text: 'stays', bold: true }])
  assert.deepEqual(parseInline(''), [{ text: '' }])
})

test('plainText strips markers for measuring and filenames', () => {
  assert.equal(plainText('**Bold** and `code`'), 'Bold and code')
})

test('empty and whitespace-only input produce no blocks', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n  \n'), [])
})

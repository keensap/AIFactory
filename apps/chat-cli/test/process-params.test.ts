import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeProcessParams, parseProcessParams, ProcessParamsError } from '../src/processes/params.ts';

function invalidAt(path: string) {
  return (error: unknown) => error instanceof ProcessParamsError &&
    error.code === 'INVALID_PROCESS_PARAMS' && error.path === path;
}

test('process params: accepts partial layers and inclusive bounds without adding defaults', () => {
  assert.deepEqual(parseProcessParams({}), {});
  const input = {
    review: { maxFindings: 12 },
    revision: { maxGrowthRatio: 1.25 },
    context: { analysisChars: 0, attachmentChars: 200_000 },
    prompt: { extraInstructions: 'a'.repeat(4_000) },
  };
  const parsed = parseProcessParams(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.context, input.context);
  assert.deepEqual(parseProcessParams({ review: { maxFindings: 1 }, revision: { maxGrowthRatio: 5 } }),
    { review: { maxFindings: 1 }, revision: { maxGrowthRatio: 5 } });
  assert.throws(() => parseProcessParams({ review: { maxFindings: 1.5 } }), invalidAt('params.review.maxFindings'));
});

test('process params: rejects unknown keys and malformed objects with their paths', () => {
  for (const input of [undefined, null, [], 1, 'params', new Date()]) {
    assert.throws(() => parseProcessParams(input), invalidAt('params'));
  }
  assert.throws(() => parseProcessParams({ model: {} }), invalidAt('params.model'));
  assert.throws(() => parseProcessParams({ prompt: [] }), invalidAt('params.prompt'));
  assert.throws(() => parseProcessParams({ revision: { allowNewRequirements: false } }),
    invalidAt('params.revision.allowNewRequirements'));
  assert.throws(() => parseProcessParams(JSON.parse('{"context":{"__proto__":{}}}')),
    invalidAt('params.context.__proto__'));
});

test('process params: rejects invalid types, lengths, ranges and integer budgets', () => {
  for (const input of [0, 13, NaN, '3', undefined]) {
    assert.throws(() => parseProcessParams({ review: { maxFindings: input } }), invalidAt('params.review.maxFindings'));
  }
  for (const input of [0.99, 5.01, Infinity, null]) {
    assert.throws(() => parseProcessParams({ revision: { maxGrowthRatio: input } }), invalidAt('params.revision.maxGrowthRatio'));
  }
  for (const field of ['analysisChars', 'baselineChars', 'attachmentChars']) {
    for (const input of [-1, 200_001, 0.25, '0']) {
      assert.throws(() => parseProcessParams({ context: { [field]: input } }), invalidAt(`params.context.${field}`));
    }
  }
  for (const input of [false, 'a'.repeat(4_001)]) {
    assert.throws(() => parseProcessParams({ prompt: { extraInstructions: input } }), invalidAt('params.prompt.extraInstructions'));
  }
});

test('process params: later layers override individual fields without mutating inputs', () => {
  const factory = { context: { analysisChars: 50, baselineChars: 20 }, review: { maxFindings: 7 } };
  const stage = { context: { analysisChars: 25 }, prompt: { extraInstructions: 'stage' } };
  const project = { review: { maxFindings: 4 }, context: { attachmentChars: 10 } };
  const run = { context: { analysisChars: 0 }, prompt: { extraInstructions: '' }, review: {} };
  assert.deepEqual(mergeProcessParams(factory, stage, project, run), {
    context: { analysisChars: 0, baselineChars: 20, attachmentChars: 10 },
    review: { maxFindings: 4 },
    prompt: { extraInstructions: '' },
  });
  assert.deepEqual(factory, { context: { analysisChars: 50, baselineChars: 20 }, review: { maxFindings: 7 } });
  assert.deepEqual(mergeProcessParams(), {});
  assert.deepEqual(mergeProcessParams(undefined, {}, project), project);
  assert.throws(() => mergeProcessParams({ review: { maxFindings: -1 } }, project), invalidAt('params.review.maxFindings'));
  assert.throws(() => mergeProcessParams(null), invalidAt('params'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, segments } from '../src/prepare.mjs';
import { mergeSummaries, statusFromExitCodes, summarize } from '../src/lib.mjs';

test('runner sizing', () => {
  assert.deepEqual([plan(20).runners, plan(20).size.name], [1, 'small']);
  assert.deepEqual([plan(200).runners, plan(200).size.name], [1, 'medium']);
  assert.deepEqual([plan(500).runners, plan(500).size.name], [1, 'large']);
  assert.deepEqual([plan(10000).runners, plan(10000).size.name], [20, 'large']);
  assert.deepEqual([plan(20, 2).runners, plan(20, 2).size.name], [2, 'small']);
});

test('execution segments', () => {
  assert.deepEqual(segments(1), { sequence: '', list: [''] });
  assert.deepEqual(segments(4), { sequence: '0,1/4,2/4,3/4,1', list: ['0:1/4', '1/4:2/4', '2/4:3/4', '3/4:1'] });
});

test('merge rules', () => {
  const a = summarize({ metrics: { http_reqs: { count: 100, rate: 10 }, http_req_duration: { avg: 100, 'p(95)': 200, max: 300 }, http_req_failed: { passes: 1, fails: 99 } } });
  const b = summarize({ metrics: { http_reqs: { count: 300, rate: 30 }, http_req_duration: { avg: 200, 'p(95)': 250, max: 900 }, http_req_failed: { passes: 3, fails: 297 } } });
  const m = mergeSummaries([a, b]);
  assert.equal(m.requests, 400);
  assert.equal(m.rps, 40);
  assert.equal(m.avgMs, 175);
  assert.equal(m.p95Ms, 250);
  assert.equal(m.maxMs, 900);
  assert.equal(m.errorRate, 0.01);
});

test('status from exit codes', () => {
  assert.equal(statusFromExitCodes([0, 0]), 'passed');
  assert.equal(statusFromExitCodes([0, 99]), 'failed');
  assert.equal(statusFromExitCodes([0, 107]), 'error');
  assert.equal(statusFromExitCodes([0, null]), 'error');
});

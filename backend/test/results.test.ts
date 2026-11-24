import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointsOf, mergeSummaries, statusFromExitCodes, summarize } from '../src/lib/results.ts';
import { plan, segments, startDelaySec } from '../src/functions/prepare/handler.ts';

test('machine sizing', () => {
  assert.deepEqual([plan(20).runners, plan(20).size.name], [1, 'small']);
  assert.deepEqual([plan(200).runners, plan(200).size.name], [1, 'medium']);
  assert.deepEqual([plan(500).runners, plan(500).size.name], [1, 'large']);
  assert.deepEqual([plan(10000).runners, plan(10000).size.name], [20, 'large']);
  assert.deepEqual([plan(20, 2).runners, plan(20, 2).size.name], [2, 'small']);
});

test('execution segments and shared start', () => {
  assert.deepEqual(segments(1), { sequence: '', list: [''] });
  assert.deepEqual(segments(4), { sequence: '0,1/4,2/4,3/4,1', list: ['0:1/4', '1/4:2/4', '2/4:3/4', '3/4:1'] });
  assert.equal(startDelaySec(1), 0);
  assert.equal(startDelaySec(2), 65);
  assert.equal(startDelaySec(200), 110);
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

test('per-API numbers from tagged sub-metrics', () => {
  const s = {
    metrics: {
      'http_reqs{name:1. Login}': { count: 10 },
      'http_req_failed{name:1. Login}': { passes: 1, fails: 9 },
      'http_req_duration{name:1. Login}': { avg: 50, 'p(95)': 80, max: 120 },
      'http_reqs{name:2. Products}': { count: 20 },
    },
  };
  const eps = endpointsOf(s);
  assert.equal(eps.length, 2);
  assert.deepEqual(eps[0], { name: '1. Login', requests: 10, failed: 1, avgMs: 50, p95Ms: 80, maxMs: 120 });
  const merged = mergeSummaries([summarize(s), summarize(s)]).endpoints[0];
  assert.equal(merged.requests, 20);
  assert.equal(merged.errorRate, 0.1);
});

test('status from exit codes', () => {
  assert.equal(statusFromExitCodes([0, 0]), 'passed');
  assert.equal(statusFromExitCodes([0, 99]), 'failed');
  assert.equal(statusFromExitCodes([0, 107]), 'error');
  assert.equal(statusFromExitCodes([0, null]), 'error');
});

// Smoke test: 5 VUs for 40 s against BASE_URL (default: Grafana's public demo app).
// Runs:  node cli/k6kt.mjs run examples/smoke.js --local   |   --cloud
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'https://quickpizza.grafana.com';

export const options = {
  vus: 5,
  duration: '40s',
  thresholds: {
    http_req_failed: ['rate<0.01'],   // under 1% errors
    http_req_duration: ['p(95)<1500'], // 95% of requests under 1.5 s
  },
};

export default function () {
  const res = http.get(`${BASE}/`);
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}

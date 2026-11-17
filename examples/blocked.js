// Security check: on AWS runners this must FAIL to reach the metadata address (expect "ip is blacklisted").
import http from 'k6/http';
import { check } from 'k6';

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate==1'] } };

export default function () {
  const r = http.get('http://169.254.170.2/v2/credentials', { timeout: '3s' });
  check(r, { 'metadata endpoint is blocked': (x) => x.status === 0 && String(x.error).includes('blacklisted') });
}

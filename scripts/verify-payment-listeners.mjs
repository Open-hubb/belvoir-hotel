import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import paymentListeners from '../api/_payment-listeners.js';

const { PAUSED_CODE } = paymentListeners;
const ENDPOINTS = Object.freeze([
  { path: '/api/bookings', method: 'POST', activeStatus: 400 },
  { path: '/api/bookings', method: 'PATCH', activeStatus: 401 },
  { path: '/api/blocks', method: 'POST', activeStatus: 401 },
  { path: '/api/blocks?id=1', method: 'DELETE', activeStatus: 401 },
  { path: '/api/flot-payment-link', method: 'POST', activeStatus: 400 },
  { path: '/api/flot-status', method: 'GET', activeStatus: 400 },
  { path: '/api/payment-webhook', method: 'POST', activeStatus: 401 },
  { path: '/api/cron-poll-payments', method: 'GET', activeStatus: 401 },
]);

export async function verifyPaymentListeners(baseUrl, expectedState, fetchImpl = fetch) {
  if (expectedState !== 'paused' && expectedState !== 'active') {
    throw new Error('--expect must be paused or active');
  }
  const origin = new URL(baseUrl);
  const checks = await Promise.all(ENDPOINTS.map(async (endpoint) => {
    const response = await fetchImpl(new URL(endpoint.path, origin), {
      method: endpoint.method,
      headers: endpoint.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: endpoint.method === 'POST' ? '{}' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    const valid = expectedState === 'paused'
      ? response.status === 503 && body.code === PAUSED_CODE && body.retryable === true
      : response.status === endpoint.activeStatus && body.code !== PAUSED_CODE;
    return {
      path: endpoint.path,
      method: endpoint.method,
      status: response.status,
      code: body.code || null,
      valid,
    };
  }));
  const failures = checks.filter((check) => !check.valid);
  if (failures.length) {
    throw new Error(
      `Payment listener ${expectedState} verification failed: ` +
      failures.map((failure) => `${failure.method} ${failure.path} returned ${failure.status}/${failure.code || 'no-code'}`).join(', '),
    );
  }
  return { ok: true, state: expectedState, checks };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  const expectedState = process.argv.find((arg) => arg.startsWith('--expect='))?.slice(9);
  const baseUrl = process.argv.find((arg) => arg.startsWith('--base-url='))?.slice(11) ||
    process.env.PAYMENT_ROLLOUT_BASE_URL;
  if (!baseUrl) throw new Error('--base-url=https://deployment.example is required');
  const result = await verifyPaymentListeners(baseUrl, expectedState);
  console.log(JSON.stringify(result));
}

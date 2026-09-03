const FLAG = 'PAYMENT_LISTENERS_ENABLED';
const PAUSED_CODE = 'PAYMENT_LISTENERS_PAUSED';
const RETRY_AFTER_SECONDS = 300;

function paymentListenersEnabled(env = process.env) {
  return env[FLAG] === 'true';
}

function pausePaymentListener(res, env = process.env) {
  if (paymentListenersEnabled(env)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
  res.status(503).json({
    code: PAUSED_CODE,
    error: 'Payment processing is temporarily unavailable. Please try again shortly.',
    retryable: true,
  });
  return true;
}

function requirePaymentListenersPaused(acknowledgement, env = process.env, argv = process.argv) {
  if (env[FLAG] !== 'false') {
    throw new Error(`${FLAG}=false is required for this rollout phase`);
  }
  if (!acknowledgement || !argv.includes(acknowledgement)) {
    throw new Error(`${acknowledgement} is required after verifying all payment endpoints are paused`);
  }
}

module.exports = {
  FLAG,
  PAUSED_CODE,
  RETRY_AFTER_SECONDS,
  paymentListenersEnabled,
  pausePaymentListener,
  requirePaymentListenersPaused,
};

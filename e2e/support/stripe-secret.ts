// The webhook signing secret the e2e dev server is given (playwright.config.ts) and the specs sign
// their fixture events with (Lead ruling 7 on #50). A local test-only value: it is no Stripe
// endpoint's secret and verifies nothing outside these tests.
export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_local_e2e_only'

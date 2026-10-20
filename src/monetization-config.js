// Second chance after a lost solo run (README, «Монетизация»).
// With both options left null the offer never appears; add ?monetization=test to the URL
// to try the whole flow with a fake ad and a fake payment.

// Rewarded ad block id from partner.adsgram.ai. Ads only play inside Telegram.
export const adsgramBlockId = null;

// Your backend URL that creates a Telegram Stars invoice: it receives
// POST { product: 'revive', initData } and answers { link } from Bot API createInvoiceLink.
export const starsInvoiceEndpoint = null;

// Shown on the button; the real price is whatever the backend puts in the invoice.
export const reviveStarsPrice = 25;

export const revivesPerRun = 1;

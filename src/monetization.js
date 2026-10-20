import { telegram } from './telegram.js';
import { adsgramBlockId, starsInvoiceEndpoint, reviveStarsPrice, revivesPerRun } from './monetization-config.js';

const adsgramSdk = 'https://sad.adsgram.ai/js/sad.min.js';
// ?monetization=test swaps both providers for local fakes so the flow can be tried anywhere.
const testMode = new URLSearchParams(location.search).get('monetization') === 'test';

let adController = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

// A stand-in for a rewarded ad: a short countdown the player can skip.
function fakeAd() {
  return new Promise(resolve => {
    const screen = document.createElement('div');
    screen.className = 'test-ad';
    screen.innerHTML = '<span>ТЕСТОВАЯ РЕКЛАМА</span><b></b><button type="button">Пропустить</button>';
    const counter = screen.querySelector('b');
    let left = 3;
    counter.textContent = left;
    const finish = result => {
      clearInterval(timer);
      screen.remove();
      resolve(result);
    };
    const timer = setInterval(() => {
      left--;
      counter.textContent = left;
      if (left <= 0) finish('granted');
    }, 1000);
    screen.querySelector('button').addEventListener('click', () => finish('cancelled'));
    document.body.append(screen);
  });
}

async function showAdsgram() {
  if (!window.Adsgram) await loadScript(adsgramSdk);
  adController ??= window.Adsgram.init({ blockId: String(adsgramBlockId) });
  try {
    const result = await adController.show();
    return result?.done ? 'granted' : 'cancelled';
  } catch (result) {
    // Adsgram rejects both when the player skips and when no ad could be shown.
    return result?.error ? 'failed' : 'cancelled';
  }
}

async function payWithStars(product) {
  if (testMode) return window.confirm(`Тестовая оплата: ${reviveStarsPrice} ⭐. Оплатить?`) ? 'granted' : 'cancelled';
  const response = await fetch(starsInvoiceEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product, initData: telegram.initData }),
  });
  if (!response.ok) throw new Error(`Invoice request failed: ${response.status}`);
  const { link } = await response.json();
  const status = await telegram.openInvoice(link);
  return status === 'paid' ? 'granted' : status === 'cancelled' ? 'cancelled' : 'failed';
}

export const monetization = {
  revivesPerRun,
  starsPrice: reviveStarsPrice,

  get adAvailable() {
    return testMode || (Boolean(adsgramBlockId) && telegram.isAvailable);
  },

  get starsAvailable() {
    return testMode || (Boolean(starsInvoiceEndpoint) && telegram.canPay);
  },

  // Each resolves to 'granted', 'cancelled' or 'failed'; only 'granted' earns the reward.
  async watchAd() {
    try {
      return testMode ? await fakeAd() : await showAdsgram();
    } catch (error) {
      console.warn('Rewarded ad unavailable.', error);
      return 'failed';
    }
  },

  async buy(product) {
    try {
      return await payWithStars(product);
    } catch (error) {
      console.warn('Stars payment failed.', error);
      return 'failed';
    }
  },
};

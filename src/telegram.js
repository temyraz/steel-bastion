const sdkUrl = 'https://telegram.org/js/telegram-web-app.js';
const sdkTimeout = 4000;
const localBestKey = 'steel-bastion-best';
const themeColor = '#111916';
let webApp = null;

const supports = version => Boolean(webApp?.isVersionAtLeast?.(version));

// Loaded at runtime so an unreachable telegram.org never blocks the game itself.
function loadSdk() {
  if (window.Telegram?.WebApp) return Promise.resolve();
  return new Promise(resolve => {
    const script = document.createElement('script');
    const timer = setTimeout(resolve, sdkTimeout);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    script.src = sdkUrl;
    script.async = true;
    script.onload = done;
    script.onerror = done;
    document.head.append(script);
  });
}

export const telegram = {
  get isAvailable() {
    return Boolean(webApp && webApp.platform && webApp.platform !== 'unknown');
  },

  get user() {
    return webApp?.initDataUnsafe?.user ?? null;
  },

  async init() {
    await loadSdk();
    webApp = window.Telegram?.WebApp ?? null;
    if (!webApp) return;
    webApp.ready();
    webApp.expand();
    if (supports('7.7')) webApp.disableVerticalSwipes();
    // The UI uses a fixed dark palette, so match Telegram's chrome to it instead of the user theme.
    if (supports('6.9')) webApp.setHeaderColor(themeColor);
    else if (supports('6.1')) webApp.setHeaderColor('secondary_bg_color');
    if (supports('6.1')) {
      webApp.setBackgroundColor(themeColor);
      webApp.BackButton.onClick(() => window.dispatchEvent(new Event('bastion:back')));
    }
  },

  setPlaying(playing) {
    if (!this.isAvailable) return;
    if (supports('6.1')) {
      if (playing) webApp.BackButton.show();
      else webApp.BackButton.hide();
    }
    if (supports('6.2')) {
      if (playing) webApp.enableClosingConfirmation();
      else webApp.disableClosingConfirmation();
    }
  },

  haptic(style = 'light') {
    if (this.isAvailable && supports('6.1')) webApp.HapticFeedback?.impactOccurred(style);
  },

  async loadBest() {
    if (this.isAvailable && supports('6.9') && webApp.CloudStorage) {
      try {
        const value = await new Promise((resolve, reject) => {
          webApp.CloudStorage.getItem(localBestKey, (error, stored) => {
            if (error) reject(new Error(error));
            else resolve(stored);
          });
        });
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      } catch (error) {
        console.warn('Telegram CloudStorage unavailable; using local storage.', error);
      }
    }

    try {
      const parsed = Number(localStorage.getItem(localBestKey));
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (error) {
      console.warn('Local storage unavailable.', error);
      return 0;
    }
  },

  async saveBest(score) {
    if (this.isAvailable && supports('6.9') && webApp.CloudStorage) {
      try {
        await new Promise((resolve, reject) => {
          webApp.CloudStorage.setItem(localBestKey, String(score), error => {
            if (error) reject(new Error(error));
            else resolve();
          });
        });
        return;
      } catch (error) {
        console.warn('Could not save to Telegram CloudStorage; using local storage.', error);
      }
    }

    try {
      localStorage.setItem(localBestKey, String(score));
    } catch (error) {
      console.warn('Could not save the local record.', error);
    }
  },

  share(text) {
    const url = window.location.href;
    if (this.isAvailable && webApp.openTelegramLink) {
      webApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
      return;
    }
    if (navigator.share) {
      navigator.share({ title: document.title, text, url }).catch(error => {
        if (error.name !== 'AbortError') console.warn('Could not share result.', error);
      });
      return;
    }
    window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  },
};

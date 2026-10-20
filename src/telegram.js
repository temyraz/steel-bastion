const sdkUrl = 'https://telegram.org/js/telegram-web-app.js';
const sdkTimeout = 4000;
const localBestKey = 'steel-bastion-best';
const progressKey = 'steel-bastion-progress';
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

  // Signed launch data; a backend checks it with the bot token before trusting the user id.
  get initData() {
    return webApp?.initData ?? '';
  },

  get platform() {
    return this.isAvailable ? webApp.platform : 'browser';
  },

  // How the Mini App was opened: an invite link, a group chat, or the bot directly.
  get launchSource() {
    if (!this.isAvailable) return 'browser';
    if (webApp.initDataUnsafe?.start_param) return 'invite';
    if (webApp.initDataUnsafe?.chat_instance) return 'chat';
    return 'direct';
  },

  get canPay() {
    return this.isAvailable && supports('6.1') && typeof webApp.openInvoice === 'function';
  },

  // Resolves to 'paid', 'cancelled', 'failed' or 'pending'.
  openInvoice(link) {
    return new Promise(resolve => webApp.openInvoice(link, status => resolve(status)));
  },

  // Room to join on launch: an invite's start parameter wins, otherwise the chat the
  // Mini App was opened from (direct links in a group give everyone the same chat_instance).
  get launchRoom() {
    const param = webApp?.initDataUnsafe?.start_param;
    if (param && /^[A-Za-z0-9_-]{4,64}$/.test(param)) return param;
    const chat = webApp?.initDataUnsafe?.chat_instance;
    return chat ? `chat${String(chat).replace(/[^A-Za-z0-9_-]/g, '_')}` : null;
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

  // Strings in Telegram CloudStorage (same on every device), falling back to localStorage.
  async loadItem(key) {
    if (this.isAvailable && supports('6.9') && webApp.CloudStorage) {
      try {
        return await new Promise((resolve, reject) => {
          webApp.CloudStorage.getItem(key, (error, stored) => {
            if (error) reject(new Error(error));
            else resolve(stored ?? '');
          });
        });
      } catch (error) {
        console.warn('Telegram CloudStorage unavailable; using local storage.', error);
      }
    }

    try {
      return localStorage.getItem(key) ?? '';
    } catch (error) {
      console.warn('Local storage unavailable.', error);
      return '';
    }
  },

  async saveItem(key, value) {
    if (this.isAvailable && supports('6.9') && webApp.CloudStorage) {
      try {
        await new Promise((resolve, reject) => {
          webApp.CloudStorage.setItem(key, value, error => {
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
      localStorage.setItem(key, value);
    } catch (error) {
      console.warn('Could not save locally.', error);
    }
  },

  async loadBest() {
    const parsed = Number(await this.loadItem(localBestKey));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  },

  saveBest(score) {
    return this.saveItem(localBestKey, String(score));
  },

  // Furthest solo sector reached: { v, level, score, players: [...] } or null.
  async loadProgress() {
    try {
      const progress = JSON.parse(await this.loadItem(progressKey) || 'null');
      return progress?.v === 1 && progress.level > 1 && Array.isArray(progress.players) ? progress : null;
    } catch {
      return null;
    }
  },

  saveProgress(progress) {
    return this.saveItem(progressKey, JSON.stringify(progress));
  },

  share(text, url = window.location.href) {
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

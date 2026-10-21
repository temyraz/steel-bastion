import { firebaseConfig } from './firebase-config.js?v=1021-1534';
import { firebaseApp, loadFirebaseModule } from './firebase.js?v=1021-1534';

// Product analytics through Google Analytics 4 (Firebase). Off until firebaseConfig.measurementId
// is set; ?debug=analytics logs every event to the console and marks it for GA DebugView.
const debug = new URLSearchParams(location.search).get('debug') === 'analytics';
const enabled = Boolean(firebaseConfig?.measurementId);
const queue = [];
let sink = null;

// GA must not receive raw identifiers, so the Telegram id is hashed; it stays stable across
// devices, which is what retention needs.
async function hashId(id) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`steel-bastion:${id}`));
  return [...new Uint8Array(digest).slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function connect(userId, properties) {
  try {
    const [app, ga] = await Promise.all([firebaseApp(), loadFirebaseModule('firebase-analytics')]);
    if (!(await ga.isSupported())) return;
    const instance = ga.getAnalytics(app);
    if (userId) ga.setUserId(instance, await hashId(userId));
    ga.setUserProperties(instance, properties);
    sink = (name, params) => ga.logEvent(instance, name, debug ? { ...params, debug_mode: true } : params);
    for (const [name, params] of queue.splice(0)) sink(name, params);
  } catch (error) {
    console.warn('Analytics unavailable.', error);
  }
}

export const analytics = {
  // userId: a stable id (Telegram users only); properties: GA user properties for segmenting.
  init({ userId = null, properties = {} } = {}) {
    if (debug) console.info('[analytics] init', { userId, properties, enabled });
    if (enabled) void connect(userId, properties);
  },

  track(name, params = {}) {
    if (debug) console.info('[analytics]', name, params);
    if (!enabled) return;
    if (sink) sink(name, params);
    else if (queue.length < 100) queue.push([name, params]);
  },
};

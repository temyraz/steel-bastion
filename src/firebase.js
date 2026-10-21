import { firebaseConfig } from './firebase-config.js?v=1021-1534';

const firebaseVersion = '10.12.2';

// Firebase modules straight from the CDN; there is no build step.
export const loadFirebaseModule = name => import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/${name}.js`);

// One shared app: multiplayer and analytics both need it, and initializeApp may run only once.
let appPromise = null;
export function firebaseApp() {
  appPromise ??= loadFirebaseModule('firebase-app').then(({ initializeApp }) => initializeApp(firebaseConfig));
  return appPromise;
}

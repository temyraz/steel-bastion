// Firebase web app config for multiplayer (see README, «Совместная игра»).
// These values are public by design; access is controlled by the database rules.
// Leave null to keep multiplayer switched off.
export const firebaseConfig = {
  apiKey: "AIzaSyDqZ-ZuZ1wiHUAP_-3c5ft920rk-dHile8",
  authDomain: "steel-bastion-1d9fe.firebaseapp.com",
  databaseURL: "https://steel-bastion-1d9fe-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "steel-bastion-1d9fe",
  storageBucket: "steel-bastion-1d9fe.firebasestorage.app",
  messagingSenderId: "33062767137",
  appId: "1:33062767137:web:b561877350eda4349b3160",
  // Google Analytics 4 stream id ("G-…"), shown in this config once Analytics is enabled
  // for the Firebase project (README, «Аналитика»). Leave null to keep analytics off.
  measurementId: null,
};

// Direct link to the Mini App from @BotFather /newapp, e.g. 'https://t.me/steel_bastion_bot/play'.
// Invites use it so friends open the game inside Telegram; empty falls back to the site URL.
export const miniAppLink = 'https://t.me/steel_bastion_bot/play';

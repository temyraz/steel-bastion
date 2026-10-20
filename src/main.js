import { TankGame } from './game.js';
import { telegram } from './telegram.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#game');
const overlay = $('#overlay');
const pauseButton = $('#pause-button');
const primaryButton = $('#primary-button');
const dpad = $('.dpad');
const directionButtons = [...document.querySelectorAll('[data-direction]')];
const fireButton = $('#fire-button');
const ui = {
  level: $('#level-value'),
  score: $('#score-value'),
  lives: $('#lives-value'),
  enemies: $('#enemy-count'),
  bossStatus: $('#boss-status'),
  bossText: $('#boss-health-text'),
  bossFill: $('#boss-health-fill'),
  kicker: $('#overlay-kicker'),
  title: $('#overlay-title'),
  copy: $('#overlay-copy'),
  button: primaryButton.querySelector('span:first-child'),
  best: $('#best-score b'),
  stageState: $('#stage-state'),
};

let state = {
  mode: 'title',
  score: 0,
  best: 0,
  level: 1,
  lives: 3,
  enemies: 0,
  boss: null,
};
let savedBest = 0;
let bestLoaded = false;
let game;

const stageStates = {
  title: 'ГОТОВНОСТЬ',
  playing: 'В БОЮ',
  paused: 'ПАУЗА',
  over: 'ОПЕРАЦИЯ ЗАВЕРШЕНА',
  won: 'СЕКТОР ЗАЧИЩЕН',
};

const setText = (element, text) => {
  if (element.textContent !== text) element.textContent = text;
};

function saveBest() {
  // Until the stored record is known, saving could overwrite a higher one.
  if (!bestLoaded || state.best <= savedBest) return;
  savedBest = state.best;
  void telegram.saveBest(savedBest);
}

function setOverlay(mode) {
  overlay.hidden = mode === 'playing';
  pauseButton.hidden = mode !== 'playing';
  ui.stageState.textContent = stageStates[mode] ?? stageStates.title;
  const content = {
    title: {
      kicker: 'ОПЕРАЦИЯ «БАСТИОН»',
      title: 'Защитите<br>ядро.',
      copy: 'Удержите рубеж, уничтожьте бронетехнику и разнесите крепость противника.',
      button: 'Начать операцию',
    },
    paused: {
      kicker: 'ПЕРЕДЫШКА',
      title: 'Операция<br>на паузе.',
      copy: 'Боевая обстановка заморожена. Возвращайтесь на рубеж, когда будете готовы.',
      button: 'Продолжить',
    },
    over: {
      kicker: 'СИГНАЛ ПОТЕРЯН',
      title: 'Рубеж<br>пал.',
      copy: `Счёт операции: ${state.score.toLocaleString('ru-RU')}. Ядро нуждается в новой защите.`,
      button: 'Новая операция',
    },
    won: {
      kicker: 'СЕКТОР ЗАЧИЩЕН',
      title: 'Крепость<br>пала.',
      copy: `Операция ${String(state.level).padStart(2, '0')} завершена. Силы противника отступили.`,
      button: 'Следующий сектор',
    },
  }[mode];
  if (!content) return;
  ui.kicker.textContent = content.kicker;
  ui.title.innerHTML = content.title;
  ui.copy.textContent = content.copy;
  ui.button.textContent = content.button;
  ui.best.textContent = String(state.best).padStart(6, '0');
}

function renderState(next) {
  const previousMode = state.mode;
  state = { ...next, best: Math.max(state.best, next.score) };
  setText(ui.level, String(state.level).padStart(2, '0'));
  setText(ui.score, String(state.score).padStart(6, '0'));
  setText(ui.lives, String(state.lives).padStart(2, '0'));
  setText(ui.enemies, state.boss ? 'КРЕПОСТЬ: ЦЕЛЬ' : `ВРАГИ: ${state.enemies}`);
  if (ui.bossStatus.hidden !== !state.boss) ui.bossStatus.hidden = !state.boss;
  if (state.boss) {
    const percent = `${Math.max(0, Math.round(state.boss.hp / state.boss.maxHp * 100))}%`;
    setText(ui.bossText, percent);
    if (ui.bossFill.style.width !== percent) ui.bossFill.style.width = percent;
  }
  if (state.mode !== previousMode) {
    if (state.mode !== 'playing') saveBest();
    setOverlay(state.mode);
    telegram.setPlaying(state.mode === 'playing');
  }
}

const keys = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};
// Held direction keys, newest last: releasing one falls back to the one still held.
const heldKeys = [];
let touchDirection = null;
let dpadPointer = null;

function applyDirection() {
  game.setDirection(touchDirection ?? keys[heldKeys.at(-1)] ?? null);
}

function setTouchDirection(direction) {
  touchDirection = direction;
  directionButtons.forEach(button => button.classList.toggle('active', button.dataset.direction === direction));
  applyDirection();
}

function directionFromPointer(event) {
  const rect = dpad.getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) < rect.width * 0.12) return touchDirection;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

function clearControls() {
  heldKeys.length = 0;
  dpadPointer = null;
  setTouchDirection(null);
  game.setFire(false);
  fireButton.classList.remove('active');
}

function startOrContinue() {
  telegram.haptic('medium');
  if (state.mode === 'paused') {
    game.togglePause();
  } else if (state.mode === 'won') {
    game.continueAfterWin();
  } else {
    game.start();
  }
}

function bindControls() {
  // One handler for the whole d-pad so sliding a finger switches direction.
  dpad.addEventListener('pointerdown', event => {
    if (dpadPointer !== null) return;
    event.preventDefault();
    dpadPointer = event.pointerId;
    dpad.setPointerCapture(event.pointerId);
    setTouchDirection(directionFromPointer(event));
  });
  dpad.addEventListener('pointermove', event => {
    if (event.pointerId === dpadPointer) setTouchDirection(directionFromPointer(event));
  });
  const releaseDpad = event => {
    if (event.pointerId !== dpadPointer) return;
    dpadPointer = null;
    setTouchDirection(null);
  };
  dpad.addEventListener('pointerup', releaseDpad);
  dpad.addEventListener('pointercancel', releaseDpad);
  dpad.addEventListener('lostpointercapture', releaseDpad);
  fireButton.addEventListener('pointerdown', event => {
    event.preventDefault();
    fireButton.setPointerCapture(event.pointerId);
    game.setFire(true);
    fireButton.classList.add('active');
  });
  const releaseFire = event => {
    event.preventDefault();
    game.setFire(false);
    fireButton.classList.remove('active');
  };
  fireButton.addEventListener('pointerup', releaseFire);
  fireButton.addEventListener('pointercancel', releaseFire);
  fireButton.addEventListener('lostpointercapture', releaseFire);

  window.addEventListener('keydown', event => {
    if (event.code in keys) {
      event.preventDefault();
      if (!heldKeys.includes(event.code)) heldKeys.push(event.code);
      applyDirection();
    } else if (event.code === 'Space') {
      event.preventDefault();
      game.setFire(true);
    } else if (event.code === 'Escape' || event.code === 'KeyP') {
      event.preventDefault();
      if (state.mode === 'playing' || state.mode === 'paused') game.togglePause();
    } else if ((event.code === 'Enter' || event.code === 'NumpadEnter') && state.mode !== 'playing') {
      // Stops a focused overlay button from also receiving a click and restarting the run.
      event.preventDefault();
      if (!event.repeat) startOrContinue();
    }
  });
  window.addEventListener('keyup', event => {
    const index = heldKeys.indexOf(event.code);
    if (index !== -1) {
      heldKeys.splice(index, 1);
      applyDirection();
    }
    if (event.code === 'Space') {
      event.preventDefault();
      game.setFire(false);
    }
  });
  window.addEventListener('blur', clearControls);
}

game = new TankGame(canvas, renderState);
setOverlay(state.mode);
bindControls();
primaryButton.addEventListener('click', startOrContinue);
pauseButton.addEventListener('click', () => game.togglePause());
window.addEventListener('bastion:back', () => {
  if (state.mode === 'playing' || state.mode === 'paused') game.togglePause();
});

void telegram.init().then(async () => {
  $('#connection').innerHTML = telegram.isAvailable
    ? '<i></i> TELEGRAM MINI APP'
    : '<i></i> БРАУЗЕР';
  if (telegram.user?.first_name) $('#player-label').textContent = `НА СВЯЗИ: ${telegram.user.first_name.toUpperCase()}`;
  telegram.setPlaying(state.mode === 'playing');
  const best = await telegram.loadBest();
  savedBest = best;
  bestLoaded = true;
  state.best = Math.max(state.best, best);
  if (state.mode !== 'playing') {
    saveBest();
    setOverlay(state.mode);
  }
});
document.addEventListener('visibilitychange', () => {
  clearControls();
  if (document.hidden && state.mode === 'playing') game.togglePause();
  if (document.hidden) saveBest();
});

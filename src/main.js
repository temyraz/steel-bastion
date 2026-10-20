import { TankGame, PLAYER_COLORS } from './game.js';
import { telegram } from './telegram.js';
import { Session, MAX_CREW, makeRoomCode, netAvailable } from './net.js';
import { miniAppLink } from './firebase-config.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#game');
const overlay = $('#overlay');
const pauseButton = $('#pause-button');
const primaryButton = $('#primary-button');
const secondaryButton = $('#secondary-button');
const leaveButton = $('#leave-button');
const dpad = $('.dpad');
const directionButtons = [...document.querySelectorAll('[data-direction]')];
const matchButtons = [...document.querySelectorAll('[data-match]')];
const fireButton = $('#fire-button');
const ui = {
  level: $('#level-value'),
  score: $('#score-value'),
  scoreLabel: $('#score-label'),
  lives: $('#lives-value'),
  enemies: $('#enemy-count'),
  objective: $('#objective'),
  bossStatus: $('#boss-status'),
  bossText: $('#boss-health-text'),
  bossFill: $('#boss-health-fill'),
  kicker: $('#overlay-kicker'),
  title: $('#overlay-title'),
  copy: $('#overlay-copy'),
  button: primaryButton.querySelector('span:first-child'),
  bestRow: $('#best-score'),
  best: $('#best-score b'),
  lobby: $('#lobby'),
  crew: $('#crew-list'),
  hint: $('#overlay-hint'),
  stageState: $('#stage-state'),
};

let state = {
  mode: 'title',
  match: 'solo',
  role: 'local',
  score: 0,
  best: 0,
  level: 1,
  lives: 3,
  kills: 0,
  enemies: 0,
  boss: null,
  crew: [],
  winner: null,
  spectator: false,
};
let savedBest = 0;
let bestLoaded = false;
let game;
let session = null;
let joining = false;
let notice = '';
let me = null;

const stageStates = {
  title: 'ГОТОВНОСТЬ',
  connecting: 'СВЯЗЬ',
  playing: 'В БОЮ',
  paused: 'ПАУЗА',
  over: 'ОПЕРАЦИЯ ЗАВЕРШЕНА',
  won: 'СЕКТОР ЗАЧИЩЕН',
};

const setText = (element, text) => {
  if (element.textContent !== text) element.textContent = text;
};

const escapeHtml = text => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

function saveBest() {
  // Until the stored record is known, saving could overwrite a higher one.
  if (!bestLoaded || state.best <= savedBest) return;
  savedBest = state.best;
  void telegram.saveBest(savedBest);
}

function identity() {
  const user = telegram.user;
  if (user?.id) return { id: `tg${user.id}`, name: user.first_name || 'Боец' };
  // Per tab, so several browser tabs can play against each other while testing.
  let id = null;
  try {
    id = sessionStorage.getItem('steel-bastion-id');
    if (!id) sessionStorage.setItem('steel-bastion-id', id = `web${Math.random().toString(36).slice(2, 10)}`);
  } catch {
    id = `web${Math.random().toString(36).slice(2, 10)}`;
  }
  return { id, name: `Боец ${id.slice(-3).toUpperCase()}` };
}

function roomLabel(room) {
  return room.startsWith('chat') ? 'ЭТОГО ЧАТА' : room;
}

function renderCrew(rows) {
  ui.crew.replaceChildren(...rows.map(row => {
    const item = document.createElement('li');
    const dot = document.createElement('i');
    const name = document.createElement('span');
    const note = document.createElement('small');
    dot.style.background = row.color ?? 'transparent';
    if (!row.color) dot.style.border = '1px solid var(--muted)';
    name.textContent = row.me ? `${row.name} (вы)` : row.name;
    note.textContent = row.note;
    item.className = row.out ? 'out' : '';
    item.append(dot, name, note);
    return item;
  }));
}

// Everything the overlay card can show, chosen from the game mode and the room state.
function overlayContent() {
  const { mode } = state;
  const host = game.role === 'host';
  if (!session) {
    const content = {
      title: {
        kicker: 'ОПЕРАЦИЯ «БАСТИОН»',
        title: 'Защитите<br>ядро.',
        copy: notice || 'Удержите рубеж, уничтожьте бронетехнику и разнесите крепость противника.',
        button: 'Начать операцию',
        secondary: 'Играть с друзьями',
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
        secondary: 'Играть с друзьями',
      },
      won: {
        kicker: 'СЕКТОР ЗАЧИЩЕН',
        title: 'Крепость<br>пала.',
        copy: `Операция ${String(state.level).padStart(2, '0')} завершена. Силы противника отступили.`,
        button: 'Следующий сектор',
      },
    }[mode];
    return content && { ...content, best: true, hint: mode === 'title' };
  }

  if (session.phase === 'lobby') {
    const commander = session.roster[0];
    const pvpShort = session.match === 'pvp' && session.roster.length < 2;
    return {
      kicker: `КОМНАТА ${roomLabel(session.room)}`,
      title: 'Сбор<br>отряда.',
      copy: session.isCommander
        ? 'Вы командир: выберите режим и начинайте, когда отряд соберётся.'
        : `Командир — ${commander?.name ?? '…'}. Ждём сигнала к бою.`,
      lobby: 'roster',
      button: session.isCommander ? (pvpShort ? 'Нужно минимум 2 игрока' : 'Начать бой') : 'Ждём командира',
      disabled: !session.isCommander || pvpShort,
      secondary: 'Пригласить друзей',
      leave: true,
    };
  }

  if (mode === 'connecting') {
    return { kicker: 'СВЯЗЬ', title: 'Подключение<br>к бою.', copy: 'Получаем обстановку от командира…', button: 'Ожидание', disabled: true, leave: true };
  }
  const shared = { lobby: 'results', disabled: !host, secondary: host ? 'В лобби' : null, leave: true };
  if (state.match === 'pvp' && mode === 'won') {
    const winner = state.crew.find(player => player.id === state.winner);
    return {
      ...shared,
      kicker: 'БОЙ ОКОНЧЕН',
      title: winner?.id === me.id ? 'Вы<br>победили.' : winner ? `${escapeHtml(winner.name)}<br>побеждает.` : 'Ничья.',
      copy: 'Итоги боя по уничтоженным танкам.',
      button: host ? 'Реванш' : 'Ждём командира',
    };
  }
  if (mode === 'won') {
    return {
      ...shared,
      kicker: 'СЕКТОР ЗАЧИЩЕН',
      title: 'Крепость<br>пала.',
      copy: `Операция ${String(state.level).padStart(2, '0')} завершена. Счёт отряда: ${state.score.toLocaleString('ru-RU')}.`,
      button: host ? 'Следующий сектор' : 'Ждём командира',
    };
  }
  if (mode === 'over') {
    return {
      ...shared,
      kicker: 'СИГНАЛ ПОТЕРЯН',
      title: 'Рубеж<br>пал.',
      copy: `Счёт отряда: ${state.score.toLocaleString('ru-RU')}. Ядро нуждается в новой защите.`,
      button: host ? 'Новый бой' : 'Ждём командира',
    };
  }
  return null;
}

function renderOverlay() {
  const playing = state.mode === 'playing';
  overlay.hidden = playing;
  pauseButton.hidden = !playing || Boolean(session);
  ui.stageState.textContent = stageStates[state.mode] ?? stageStates.title;
  const content = overlayContent();
  if (playing || !content) return;
  ui.kicker.textContent = content.kicker;
  ui.title.innerHTML = content.title;
  ui.copy.textContent = content.copy;
  ui.button.textContent = content.button;
  primaryButton.disabled = Boolean(content.disabled);
  secondaryButton.hidden = !content.secondary;
  if (content.secondary) secondaryButton.textContent = content.secondary;
  leaveButton.hidden = !content.leave;
  ui.bestRow.hidden = !content.best;
  ui.best.textContent = String(state.best).padStart(6, '0');
  ui.hint.hidden = !content.hint;
  ui.lobby.hidden = !content.lobby;
  const showModes = content.lobby === 'roster';
  matchButtons[0].parentElement.hidden = !showModes;
  if (showModes) {
    for (const button of matchButtons) {
      button.setAttribute('aria-checked', String(button.dataset.match === session.match));
      button.disabled = !session.isCommander;
    }
    renderCrew(session.roster.map((player, index) => ({
      name: player.name,
      me: player.id === me.id,
      color: index < MAX_CREW ? PLAYER_COLORS[index] : null,
      note: index === 0 ? 'КОМАНДИР' : index < MAX_CREW ? 'В ОТРЯДЕ' : 'В РЕЗЕРВЕ',
    })));
  } else if (content.lobby === 'results') {
    const crew = [...state.crew].sort((a, b) => state.match === 'pvp' ? b.kills - a.kills : a.slot - b.slot);
    renderCrew(crew.map(player => ({
      name: player.name,
      me: player.id === me.id,
      color: PLAYER_COLORS[player.slot],
      out: player.lives <= 0,
      note: `${state.match === 'pvp' ? 'ФРАГИ' : 'ПОДБИТО'} ${player.kills}`,
    })));
  }
}

function renderState(next) {
  const previousMode = state.mode;
  state = { ...next, best: next.match === 'pvp' ? state.best : Math.max(state.best, next.score) };
  const pvp = state.match === 'pvp';
  setText(ui.level, pvp ? 'PVP' : String(state.level).padStart(2, '0'));
  setText(ui.scoreLabel, pvp ? 'ФРАГИ' : 'СЧЁТ');
  setText(ui.score, String(pvp ? state.kills : state.score).padStart(6, '0'));
  setText(ui.lives, String(state.lives).padStart(2, '0'));
  let caption = state.boss ? 'КРЕПОСТЬ: ЦЕЛЬ' : `ВРАГИ: ${state.enemies}`;
  if (pvp) caption = `В СТРОЮ: ${state.crew.filter(player => player.lives > 0).length}`;
  if (session && state.spectator && state.mode === 'playing') caption = 'ВЫ ЗРИТЕЛЬ';
  setText(ui.enemies, caption);
  setText(ui.objective, pvp ? 'ЗАДАЧА: ОСТАТЬСЯ ПОСЛЕДНИМ' : 'ЗАДАЧА: ЗАЩИТИТЬ ЯДРО');
  if (ui.bossStatus.hidden !== !state.boss) ui.bossStatus.hidden = !state.boss;
  if (state.boss) {
    const percent = `${Math.max(0, Math.round(state.boss.hp / state.boss.maxHp * 100))}%`;
    setText(ui.bossText, percent);
    if (ui.bossFill.style.width !== percent) ui.bossFill.style.width = percent;
  }
  if (state.mode !== previousMode) {
    if (state.mode !== 'playing') saveBest();
    renderOverlay();
    telegram.setPlaying(state.mode === 'playing');
  }
}

async function openRoom(room) {
  if (session || joining) return;
  if (!netAvailable) {
    notice = 'Сетевая игра ещё не настроена: нужно подключить Firebase (инструкция в README).';
    renderOverlay();
    return;
  }
  joining = true;
  notice = 'Подключение к комнате…';
  renderOverlay();
  try {
    me ??= identity();
    game.localId = me.id;
    game.reset();
    session = await Session.join({ room, me, game, onChange: renderOverlay });
    notice = '';
  } catch (error) {
    console.error('Could not join the room.', error);
    notice = 'Не удалось подключиться к комнате. Проверьте интернет и настройки Firebase.';
  } finally {
    joining = false;
    renderOverlay();
  }
}

async function leaveRoom() {
  if (!session) return;
  const leaving = session;
  session = null;
  clearControls();
  await leaving.leave();
  renderOverlay();
}

function inviteFriends() {
  const room = session.room;
  let url;
  if (miniAppLink) {
    url = `${miniAppLink}?startapp=${encodeURIComponent(room)}`;
  } else {
    const link = new URL(window.location.href);
    link.search = '';
    link.searchParams.set('room', room);
    if (new URLSearchParams(window.location.search).get('net') === 'local') link.searchParams.set('net', 'local');
    url = link.href;
  }
  telegram.share('Заходи в мой отряд в «Стальном Бастионе»!', url);
}

function primaryAction() {
  telegram.haptic('medium');
  if (!session) {
    if (state.mode === 'paused') game.togglePause();
    else if (state.mode === 'won') game.continueAfterWin();
    else game.start();
    return;
  }
  if (session.phase === 'lobby') {
    session.startBattle();
  } else if (game.role === 'host') {
    if (state.mode === 'won' && state.match !== 'pvp') game.continueAfterWin();
    else session.startBattle();
  }
}

function secondaryAction() {
  telegram.haptic('light');
  if (!session) void openRoom(makeRoomCode());
  else if (session.phase === 'lobby') inviteFriends();
  else if (game.role === 'host') session.toLobby();
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

// A client's tank lives on the host, so its controls go over the network.
function pushInput() {
  if (session && game.role === 'client') session.sendInput(game.input);
}

function applyDirection() {
  game.setDirection(touchDirection ?? keys[heldKeys.at(-1)] ?? null);
  pushInput();
}

function setFire(fire) {
  game.setFire(fire);
  pushInput();
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
  setFire(false);
  fireButton.classList.remove('active');
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
    setFire(true);
    fireButton.classList.add('active');
  });
  const releaseFire = event => {
    event.preventDefault();
    setFire(false);
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
      if (!event.repeat) setFire(true);
    } else if (event.code === 'Escape' || event.code === 'KeyP') {
      event.preventDefault();
      if (state.mode === 'playing' || state.mode === 'paused') game.togglePause();
    } else if ((event.code === 'Enter' || event.code === 'NumpadEnter') && state.mode !== 'playing') {
      // Stops a focused overlay button from also receiving a click and restarting the run.
      event.preventDefault();
      if (!event.repeat && !primaryButton.disabled) primaryAction();
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
      setFire(false);
    }
  });
  window.addEventListener('blur', clearControls);
}

game = new TankGame(canvas, renderState);
renderOverlay();
bindControls();
primaryButton.addEventListener('click', primaryAction);
secondaryButton.addEventListener('click', secondaryAction);
leaveButton.addEventListener('click', () => void leaveRoom());
for (const button of matchButtons) button.addEventListener('click', () => session?.setMatch(button.dataset.match));
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
  // Opened from a group chat or an invite link: go straight to that room's lobby.
  const urlRoom = new URLSearchParams(window.location.search).get('room');
  const room = telegram.launchRoom ?? (urlRoom && /^[A-Za-z0-9_-]{4,64}$/.test(urlRoom) ? urlRoom : null);
  if (room && netAvailable) void openRoom(room);
  const best = await telegram.loadBest();
  savedBest = best;
  bestLoaded = true;
  state.best = Math.max(state.best, best);
  if (state.mode !== 'playing') {
    saveBest();
    renderOverlay();
  }
});
document.addEventListener('visibilitychange', () => {
  clearControls();
  if (document.hidden && state.mode === 'playing') game.togglePause();
  if (document.hidden) saveBest();
});

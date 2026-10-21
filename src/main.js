import { TankGame, PLAYER_COLORS } from './game.js?v=1021-1534';
import { WAR_TEAMS } from './war.js?v=1021-1534';
import { telegram } from './telegram.js?v=1021-1534';
import { Session, MAX_CREW, makeRoomCode, netAvailable } from './net.js?v=1021-1534';
import { miniAppLink } from './firebase-config.js?v=1021-1534';
import { analytics } from './analytics.js?v=1021-1534';
import { monetization } from './monetization.js?v=1021-1534';

const $ = selector => document.querySelector(selector);
const canvas = $('#game');
const overlay = $('#overlay');
const pauseButton = $('#pause-button');
const primaryButton = $('#primary-button');
const secondaryButton = $('#secondary-button');
const botButton = $('#bot-button');
const warButton = $('#war-button');
const soloModes = $('#solo-modes');
const continueButton = $('#continue-button');
const leaveButton = $('#leave-button');
const reviveBox = $('#revive');
const reviveAdButton = $('#revive-ad-button');
const reviveStarsButton = $('#revive-stars-button');
const dpad = $('.dpad');
const directionButtons = [...document.querySelectorAll('[data-direction]')];
const matchButtons = [...document.querySelectorAll('[data-match]')];
const fireButton = $('#fire-button');
const fireButtons = [...document.querySelectorAll('[data-fire]')];
const selectButton = $('#select-button');
const startButton = $('#start-button');
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
// Solo runs with a bot teammate; "Новая операция" keeps the same setup.
let withBot = false;
// Local match type for the solo buttons: 'solo' (waves, optionally with a bot) or 'war' (army vs bot army).
let soloMatch = 'solo';
// Furthest solo checkpoint (sector start) and whether it has been read from storage yet.
let savedRun = null;
let progressLoaded = false;
let checkpointLevel = 0;
// Second chance after a lost solo run, paid with a rewarded ad or Stars.
let revivesUsed = 0;
let reviveBusy = false;
let reviveNotice = '';
let reviveOffered = false;
let reviving = false;
// Analytics timing: the current run and the current sector.
let runStartedAt = 0;
let sectorStartedAt = 0;

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
  analytics.track('new_best', { score: state.best, previous: savedBest });
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
  if (state.match === 'war' && mode === 'won') {
    const runs = !session || host;
    return {
      ...warResult(),
      lobby: 'results',
      button: runs ? 'Реванш' : 'Ждём командира',
      disabled: !runs,
      secondary: session ? (host ? 'В лобби' : null) : 'Играть с друзьями',
      leave: Boolean(session),
    };
  }
  if (!session) {
    const revive = canRevive();
    const content = {
      title: {
        kicker: 'ОПЕРАЦИЯ «БАСТИОН»',
        title: 'Защитите<br>ядро.',
        copy: notice || 'Удержите рубеж, уничтожьте бронетехнику и разнесите крепость противника.',
        button: 'Начать операцию',
        secondary: 'Играть с друзьями',
        bot: true,
        resume: true,
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
        copy: reviveNotice || (revive
          ? `Счёт: ${state.score.toLocaleString('ru-RU')}. Ядро можно поднять из руин под защитой стальных стен — один раз за операцию.`
          : `Счёт операции: ${state.score.toLocaleString('ru-RU')}. Ядро нуждается в новой защите.`),
        button: withBot ? 'Новая операция с ботом' : 'Новая операция',
        secondary: 'Играть с друзьями',
        resume: true,
        revive,
      },
      won: {
        kicker: 'СЕКТОР ЗАЧИЩЕН',
        title: 'Крепость<br>пала.',
        copy: state.crew.length > 1
          ? `Операция ${String(state.level).padStart(2, '0')} завершена. ${topScorer()}`
          : `Операция ${String(state.level).padStart(2, '0')} завершена. Силы противника отступили.`,
        button: 'Следующий сектор',
        lobby: state.crew.length > 1 ? 'results' : null,
      },
    }[mode];
    return content && { ...content, best: true, hint: mode === 'title' };
  }

  if (session.phase === 'lobby') {
    const commander = session.roster[0];
    const pvpShort = session.match !== 'coop' && session.roster.length < 2;
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
      copy: `Операция ${String(state.level).padStart(2, '0')} завершена. ${topScorer()}`,
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

function warResult() {
  const war = state.war ?? {};
  const won = war.winnerTeam === war.team;
  return {
    kicker: won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ',
    title: won ? 'Вражеская база<br>пала.' : 'Наша база<br>пала.',
    copy: `${won ? 'Ваша армия прорвалась.' : 'Армия противника прорвалась.'} ${topScorer()}`,
  };
}

// End-of-round line naming whoever destroyed the most tanks (worded without gendered verbs).
function topScorer() {
  const [first, second] = [...state.crew].sort((a, b) => b.roundKills - a.roundKills);
  if (!first || !first.roundKills) return 'Подбитых танков нет ни у кого.';
  if (second && second.roundKills === first.roundKills) return `Поровну: по ${first.roundKills} подбитых у лучших.`;
  const who = first.id === game.localId ? 'у вас' : first.bot ? 'у бота' : `у ${first.name}`;
  return `Больше всех подбитых танков ${who}: ${first.roundKills}.`;
}

function renderOverlay() {
  const playing = state.mode === 'playing';
  overlay.hidden = playing;
  document.body.classList.toggle('playing', playing);
  if (!playing) releaseScreenTouches();
  pauseButton.hidden = !playing || Boolean(session);
  ui.stageState.textContent = stageStates[state.mode] ?? stageStates.title;
  const content = overlayContent();
  if (playing || !content) return;
  ui.kicker.textContent = content.kicker;
  ui.title.innerHTML = content.title;
  ui.copy.textContent = content.copy;
  ui.button.textContent = content.button;
  // While an ad or a payment is open nothing else on the card may start a new run.
  primaryButton.disabled = Boolean(content.disabled) || reviveBusy;
  continueButton.disabled = reviveBusy;
  secondaryButton.disabled = reviveBusy;
  reviveBox.hidden = !content.revive;
  if (content.revive) {
    reviveAdButton.hidden = !monetization.adAvailable;
    reviveStarsButton.hidden = !monetization.starsAvailable;
    reviveBox.classList.toggle('single', reviveAdButton.hidden || reviveStarsButton.hidden);
    reviveAdButton.disabled = reviveStarsButton.disabled = reviveBusy;
    $('#revive-price').textContent = `⭐ ${monetization.starsPrice}`;
    if (!reviveOffered) {
      reviveOffered = true;
      analytics.track('revive_offer', {
        level: state.level, score: state.score, ad: monetization.adAvailable, stars: monetization.starsAvailable,
      });
    }
  }
  soloModes.hidden = !content.bot;
  continueButton.hidden = !(content.resume && savedRun);
  if (!continueButton.hidden) {
    const withSavedBot = savedRun.players.some(player => player.bot);
    continueButton.textContent = `Продолжить: сектор ${String(savedRun.level).padStart(2, '0')}${withSavedBot ? ' с ботом' : ''}`;
  }
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
    const crew = [...state.crew].sort((a, b) => b.roundKills - a.roundKills || a.slot - b.slot);
    renderCrew(crew.map(player => ({
      name: player.name,
      me: player.id === game.localId && player.name !== 'Вы',
      color: PLAYER_COLORS[player.slot],
      out: player.lives <= 0,
      note: `${state.match === 'pvp' ? 'ФРАГИ' : 'ПОДБИТО ТАНКОВ'}: ${player.roundKills}`,
    })));
  }
}

function runKind() {
  if (state.match !== 'solo') return state.match;
  return state.crew.some(player => player.bot) ? 'bot' : 'solo';
}

// Analytics for runs and sectors, driven by game mode changes.
function trackTransition(previousMode) {
  const now = performance.now();
  const seconds = since => Math.round((now - since) / 1000);
  if (state.mode === 'playing') {
    // Resuming from pause or a revive continues the same sector.
    if (previousMode === 'paused' || reviving) return;
    sectorStartedAt = now;
    if (previousMode === 'won' && state.match !== 'pvp') return;
    runStartedAt = now;
    revivesUsed = 0;
    analytics.track('game_start', { mode: runKind(), players: state.crew.length, role: state.role, level: state.level });
  } else if (state.mode === 'won') {
    if (state.match === 'pvp') {
      analytics.track('pvp_end', { won: state.winner === game.localId, players: state.crew.length, duration_s: seconds(sectorStartedAt) });
    } else {
      analytics.track('level_complete', { level: state.level, score: state.score, duration_s: seconds(sectorStartedAt), revives: revivesUsed });
    }
  } else if (state.mode === 'over') {
    reviveOffered = false;
    reviveNotice = '';
    analytics.track('game_over', {
      mode: runKind(), level: state.level, score: state.score, reason: state.overReason ?? 'unknown',
      duration_s: seconds(runStartedAt), kills: state.kills, revives: revivesUsed,
    });
  }
}

function canRevive() {
  return !session && state.mode === 'over' && state.match === 'solo' && game.role === 'local' &&
    revivesUsed < monetization.revivesPerRun && (monetization.adAvailable || monetization.starsAvailable);
}

async function revive(method) {
  if (reviveBusy || !canRevive()) return;
  telegram.haptic('light');
  reviveBusy = true;
  reviveNotice = '';
  renderOverlay();
  const result = method === 'ad' ? await monetization.watchAd() : await monetization.buy('revive');
  reviveBusy = false;
  analytics.track('revive_result', { method, result, level: state.level });
  if (result === 'granted' && state.mode === 'over') {
    revivesUsed++;
    reviving = true;
    game.revive();
    reviving = false;
    telegram.haptic('heavy');
    return;
  }
  if (result === 'failed') {
    reviveNotice = method === 'ad'
      ? 'Реклама сейчас недоступна. Попробуйте ещё раз чуть позже или начните операцию заново.'
      : 'Оплата не прошла. Попробуйте ещё раз или начните операцию заново.';
  }
  renderOverlay();
}

function renderState(next) {
  const previousMode = state.mode;
  const versus = next.match === 'pvp' || next.match === 'war';
  state = { ...next, best: versus ? state.best : Math.max(state.best, next.score) };
  const pvp = state.match === 'pvp';
  const war = state.match === 'war' ? state.war : null;
  setText(ui.level, pvp ? 'PVP' : war ? 'WAR' : String(state.level).padStart(2, '0'));
  setText(ui.scoreLabel, versus ? 'ФРАГИ' : 'СЧЁТ');
  setText(ui.score, String(versus ? state.kills : state.score).padStart(6, '0'));
  setText(ui.lives, String(state.lives).padStart(2, '0'));
  let caption = state.boss ? (state.boss.guns ? `ПУШКИ: ${state.boss.guns}` : 'КОРПУС: ОГОНЬ!') : `ВРАГИ: ${state.enemies}`;
  if (pvp) caption = `В СТРОЮ: ${state.crew.filter(player => player.lives > 0).length}`;
  if (war) {
    const [ours, theirs] = WAR_TEAMS.map(offset => (war.team + offset) % 2);
    caption = `БАЗА ${war.bases[ours] ?? 0}:${war.bases[theirs] ?? 0} · АРМИЯ ${war.army[ours]}:${war.army[theirs]}`;
  }
  if (session && state.spectator && state.mode === 'playing') caption = 'ВЫ ЗРИТЕЛЬ';
  setText(ui.enemies, caption);
  let objective = pvp ? 'ЗАДАЧА: ОСТАТЬСЯ ПОСЛЕДНИМ' : war ? 'ЦЕЛЬ: БАЗА ВРАГА' : 'ЗАДАЧА: ЗАЩИТИТЬ ЯДРО';
  if (!pvp && !war && state.fort > 0) objective = `ЯДРО УКРЕПЛЕНО: ${state.fort} С`;
  setText(ui.objective, objective);
  if (ui.bossStatus.hidden !== !state.boss) ui.bossStatus.hidden = !state.boss;
  if (state.boss) {
    const percent = `${Math.max(0, Math.round(state.boss.hp / state.boss.maxHp * 100))}%`;
    setText(ui.bossText, percent);
    if (ui.bossFill.style.width !== percent) ui.bossFill.style.width = percent;
  }
  saveCheckpoint();
  if (state.mode !== previousMode) {
    markPadChoice(null);
    trackTransition(previousMode);
    if (state.mode !== 'playing') saveBest();
    renderOverlay();
    telegram.setPlaying(state.mode === 'playing');
  }
}

// source: 'create' from the button, 'launch' when opened from a group or an invite.
async function openRoom(room, source = 'create') {
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
    analytics.track('room_open', { source });
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
  analytics.track('invite_share');
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
  if (reviveBusy) return;
  telegram.haptic('medium');
  if (!session) {
    if (state.mode === 'paused') game.togglePause();
    else if (state.mode === 'won' && state.match !== 'war') game.continueAfterWin();
    else {
      if (state.mode === 'title') {
        withBot = false;
        soloMatch = 'solo';
      }
      startSolo();
    }
    return;
  }
  if (session.phase === 'lobby') {
    session.startBattle();
  } else if (game.role === 'host') {
    if (state.mode === 'won' && state.match === 'coop') game.continueAfterWin();
    else session.startBattle();
  }
}

// At the start of each solo sector from 02 on, remember it if it is the furthest one so far.
function saveCheckpoint() {
  // renderState already runs from inside the TankGame constructor, before `game` is assigned.
  if (!game || game.role !== 'local' || state.match !== 'solo' || state.mode !== 'playing') return;
  if (state.level === 1) checkpointLevel = 0;
  if (!progressLoaded || state.level < 2 || state.level === checkpointLevel) return;
  checkpointLevel = state.level;
  if (savedRun && savedRun.level > state.level) return;
  savedRun = game.exportProgress();
  void telegram.saveProgress(savedRun);
}

function resumeRun() {
  if (!savedRun) return;
  telegram.haptic('medium');
  withBot = savedRun.players.some(player => player.bot);
  checkpointLevel = savedRun.level;
  game.resumeProgress(savedRun);
}

function startSolo() {
  if (soloMatch === 'war') {
    game.start({ match: 'war', roster: [{ id: game.localId, name: 'Вы' }, { id: 'bot', name: 'Бот', bot: true }] });
    return;
  }
  const roster = [{ id: game.localId, name: 'Вы' }];
  if (withBot) roster.push({ id: 'bot', name: 'Бот', bot: true });
  game.start({ match: 'solo', roster });
}

function playWar() {
  telegram.haptic('medium');
  soloMatch = 'war';
  startSolo();
}

function playWithBot() {
  soloMatch = 'solo';
  telegram.haptic('medium');
  withBot = true;
  startSolo();
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
// Touches anywhere on screen: left half is a floating stick, right half holds fire.
const stickDeadZone = 14;
const stickRadius = 56;
let stickPointer = null;
let stickOrigin = null;
const firePointers = new Set();
// The pad's B/A buttons and right-half screen touches fire together; firing stops when all let go.
const padFirePointers = new Set();
// Overlay button picked with SELECT (null: the primary button).
let padChoice = null;
const stick = document.createElement('div');
stick.className = 'touch-stick';
stick.hidden = true;
stick.innerHTML = '<i></i>';
document.body.append(stick);

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

function moveStick(event) {
  let dx = event.clientX - stickOrigin.x;
  let dy = event.clientY - stickOrigin.y;
  const distance = Math.hypot(dx, dy);
  // Drag the anchor along so reversing direction never needs a long swipe back.
  if (distance > stickRadius) {
    stickOrigin.x += dx * (1 - stickRadius / distance);
    stickOrigin.y += dy * (1 - stickRadius / distance);
    dx = event.clientX - stickOrigin.x;
    dy = event.clientY - stickOrigin.y;
    stick.style.left = `${stickOrigin.x}px`;
    stick.style.top = `${stickOrigin.y}px`;
  }
  stick.firstChild.style.transform = `translate(${dx}px, ${dy}px)`;
  if (Math.hypot(dx, dy) < stickDeadZone) return;
  if (Math.abs(dx) > Math.abs(dy)) setTouchDirection(dx > 0 ? 'right' : 'left');
  else setTouchDirection(dy > 0 ? 'down' : 'up');
}

// Drops screen touches when the overlay takes over; their pointerup would no longer match.
function releaseScreenTouches() {
  if (stickPointer !== null) {
    stickPointer = null;
    setTouchDirection(null);
  }
  stick.hidden = true;
  if (firePointers.size) {
    firePointers.clear();
    if (!padFirePointers.size) releaseFireInput();
  }
}

function releaseFireInput() {
  setFire(false);
  fireButtons.forEach(button => button.classList.remove('active'));
}

// Overlay buttons SELECT can walk through, in screen order.
function overlayChoices() {
  return [...overlay.querySelectorAll('button')].filter(button => !button.disabled && button.offsetParent);
}

function markPadChoice(button) {
  overlay.querySelector('.pad-selected')?.classList.remove('pad-selected');
  padChoice = button;
  button?.classList.add('pad-selected');
}

function pressSelect() {
  telegram.haptic('light');
  if (overlay.hidden) return;
  const choices = overlayChoices();
  if (!choices.length) return;
  const current = choices.indexOf(padChoice ?? primaryButton);
  markPadChoice(choices[(current + 1) % choices.length]);
}

// START confirms the outlined overlay button (the primary one by default) or pauses the battle.
function pressStart() {
  if (!overlay.hidden) {
    const target = padChoice && padChoice.offsetParent && !padChoice.disabled ? padChoice : primaryButton;
    markPadChoice(null);
    if (!target.disabled) target.click();
    return;
  }
  telegram.haptic('light');
  game.togglePause();
}

function clearControls() {
  heldKeys.length = 0;
  dpadPointer = null;
  padFirePointers.clear();
  releaseScreenTouches();
  setTouchDirection(null);
  setFire(false);
  fireButtons.forEach(button => button.classList.remove('active'));
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
  for (const button of fireButtons) {
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      // Capture keeps the press when the thumb slides off; some WebViews refuse it, which is harmless.
      try {
        button.setPointerCapture(event.pointerId);
      } catch {}
      padFirePointers.add(event.pointerId);
      setFire(true);
      button.classList.add('active');
    });
    const releaseFire = event => {
      event.preventDefault();
      if (!padFirePointers.delete(event.pointerId)) return;
      button.classList.remove('active');
      if (!padFirePointers.size && !firePointers.size) releaseFireInput();
    };
    button.addEventListener('pointerup', releaseFire);
    button.addEventListener('pointercancel', releaseFire);
    button.addEventListener('lostpointercapture', releaseFire);
  }
  // Fired on press like a real pad; click would wait for the finger to lift.
  for (const [button, press] of [[selectButton, pressSelect], [startButton, pressStart]]) {
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      button.classList.add('active');
      press();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, () => button.classList.remove('active'));
  }

  window.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || state.mode !== 'playing') return;
    if (event.target.closest('button, a, input, .gamepad, .overlay')) return;
    event.preventDefault();
    if (event.clientX < window.innerWidth / 2) {
      if (stickPointer !== null) return;
      stickPointer = event.pointerId;
      stickOrigin = { x: event.clientX, y: event.clientY };
      stick.style.left = `${stickOrigin.x}px`;
      stick.style.top = `${stickOrigin.y}px`;
      stick.firstChild.style.transform = '';
      stick.hidden = false;
    } else {
      firePointers.add(event.pointerId);
      setFire(true);
      fireButton.classList.add('active');
    }
  });
  window.addEventListener('pointermove', event => {
    if (event.pointerId === stickPointer) moveStick(event);
  });
  const releaseScreenTouch = event => {
    if (event.pointerId === stickPointer) {
      stickPointer = null;
      stick.hidden = true;
      setTouchDirection(null);
    } else if (firePointers.delete(event.pointerId) && firePointers.size === 0 && !padFirePointers.size) {
      releaseFireInput();
    }
  };
  window.addEventListener('pointerup', releaseScreenTouch);
  window.addEventListener('pointercancel', releaseScreenTouch);

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
game.onBlast = kind => telegram.haptic(kind === 'tank' ? 'light' : 'heavy');
if (matchMedia('(pointer: coarse)').matches) ui.hint.textContent = 'КАСАНИЕ СЛЕВА — ДВИЖЕНИЕ · СПРАВА — ОГОНЬ';
renderOverlay();
bindControls();
primaryButton.addEventListener('click', primaryAction);
secondaryButton.addEventListener('click', secondaryAction);
botButton.addEventListener('click', playWithBot);
warButton.addEventListener('click', playWar);
continueButton.addEventListener('click', resumeRun);
reviveAdButton.addEventListener('click', () => void revive('ad'));
reviveStarsButton.addEventListener('click', () => void revive('stars'));
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
  analytics.init({
    userId: telegram.user?.id ? `tg${telegram.user.id}` : null,
    properties: { platform: telegram.platform, launch_source: telegram.launchSource },
  });
  analytics.track('app_open', { source: telegram.launchSource, platform: telegram.platform });
  if (room && netAvailable) void openRoom(room, 'launch');
  savedRun = await telegram.loadProgress();
  progressLoaded = true;
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

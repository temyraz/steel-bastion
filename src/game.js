const SIZE = 208;
const TILE = 16;
const GRID = SIZE / TILE;
const BASE = { x: 96, y: 192, w: TILE, h: TILE };
const DIRECTIONS = {
  up: { x: 0, y: -1, angle: 0 },
  right: { x: 1, y: 0, angle: Math.PI / 2 },
  down: { x: 0, y: 1, angle: Math.PI },
  left: { x: -1, y: 0, angle: -Math.PI / 2 },
};
const WALL = 1;
const STEEL = 2;
const WATER = 3;
const GRASS = 4;
const FULL_BRICK = 0b1111;
const MAX_POWER = 3;
const MAX_PLAYERS = 4;
const GOLD = '#f2c94c';

// One palette per player slot; slot 0 is the solo player's tank.
const PLAYER_STYLES = [
  { light: '#e4fb9c', hull: '#a5c85a', dark: '#3e5228', track: '#232c1b' },
  { light: '#b9e3fb', hull: '#5d9fd0', dark: '#284a66', track: '#162636' },
  { light: '#f8c0e2', hull: '#c4609f', dark: '#5a2a4a', track: '#2e1726' },
  { light: '#f4f6f4', hull: '#b5bfbb', dark: '#4f5755', track: '#262b2a' },
];
export const PLAYER_COLORS = PLAYER_STYLES.map(style => style.hull);
const TANK_STYLES = {
  basic: { light: '#eaa577', hull: '#b8673f', dark: '#5e3221', track: '#2f1f18' },
  fast: { light: '#aeead0', hull: '#58a888', dark: '#2a5244', track: '#1a302a' },
  armor: { light: '#c8bcf5', hull: '#8070ba', dark: '#3b305f', track: '#211c34' },
  hit: { light: '#ffffff', hull: '#f3edbd', dark: '#b9b28d', track: '#77735e' },
};
const ENEMY_TURNS = {
  up: ['down', 'left', 'right'],
  right: ['down', 'left', 'up'],
  down: ['left', 'right', 'up'],
  left: ['down', 'right', 'up'],
};
// Tiles that shield the base; the fort bonus turns them to steel for a while.
const FORT_CELLS = [[5, 11], [7, 11], [5, 12], [7, 12], [6, 11]];
const FORT_TIME = 15;
const FORT_BLINK = 3;
// Picking up the fort bonus again in the same sector: the 2nd adds armour that takes one hit,
// the 3rd mounts a gun on the base that fires in a random direction.
const BASE_ARMOR_LEVEL = 2;
const BASE_GUN_LEVEL = 3;
const BASE_GUN_DELAY = 5;
const REDUCED_MOTION = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const COOP_SPAWNS = [[64, 176], [128, 176], [64, 160], [128, 160]];
const PVP_SPAWNS = [[0, 0], [192, 192], [192, 0], [0, 192]];

// Compact indexes used in network snapshots.
const DIR_NAMES = ['up', 'right', 'down', 'left'];
const ENEMY_TYPES = ['basic', 'fast', 'armor'];
const BONUS_KINDS = ['shield', 'life', 'star', 'boat', 'fort', 'speed'];
// Each speed bonus adds a quarter to the player's driving speed, up to two.
const MAX_SPEED_LEVEL = 2;
const FX_KINDS = ['spark', 'brick', 'tank', 'boss', 'base'];

const overlapsRect = (x, y, w, h, b) =>
  x < b.x + b.w && x + w > b.x &&
  y < b.y + b.h && y + h > b.y;
const round = value => Math.round(value * 10) / 10;
// The boss is a wide tank facing down: two turrets on its front, then a triple gun in the middle.
const BOSS_W = 40;
const BOSS_H = 22;
const BOSS_GUNS = [12, 28];
const BOSS_CORE = 20;
// A shell coming in from the front hits whatever sits in its column of the hull.
const bossColumn = (boss, dx) => ({ x: boss.x + dx - 5, y: boss.y, w: 10, h: boss.h });
const nearestAngle = (from, targets) => {
  let best = null;
  for (const t of targets) {
    const dx = t.x + 8 - from.x, dy = t.y + 8 - from.y, d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { d, angle: Math.atan2(dy, dx) };
  }
  return best?.angle ?? Math.PI / 2;
};
// Shells only go forward and sideways, never back over the boss.
const clampAim = angle => {
  const a = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (a >= 0.15 && a <= Math.PI - 0.15) return a;
  return Math.cos(a) > 0 ? 0.15 : Math.PI - 0.15;
};

// Roles: 'local' runs a solo game, 'host' runs a shared game and publishes snapshots,
// 'client' only renders snapshots received from the host.
export class TankGame {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layerCtx = this.layer.getContext('2d');
    this.grassLayer = document.createElement('canvas');
    this.grassCtx = this.grassLayer.getContext('2d');
    this.layerDirty = true;
    this.needsDraw = true;
    this.onChange = onChange;
    this.input = { direction: null, fire: false };
    this.localId = 'me';
    this.role = 'local';
    this.match = 'solo';
    this.mode = 'title';
    this.score = 0;
    this.level = 1;
    this.frame = 0;
    this.lastTime = 0;
    this.lastUi = 0;
    this.mapVersion = 0;
    // Visual effects: ids let clients replay each blast from snapshots exactly once.
    this.nextFx = 1;
    this.lastFx = 0;
    this.clearEffects();
    this.onBlast = null;
    this.destroyed = false;
    this.resizeObserver = new ResizeObserver(entries => this.resize(entries[0]));
    this.resizeObserver.observe(canvas);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.reset();
  }

  resize(entry) {
    const box = entry.devicePixelContentBoxSize?.[0];
    const pixels = box
      ? box.inlineSize * Math.min(1, 3 / (window.devicePixelRatio || 1))
      : entry.contentRect.width * Math.min(3, window.devicePixelRatio || 1);
    // Integer scale keeps pixel art crisp and avoids seams between tiles.
    const width = SIZE * Math.max(1, Math.round(pixels / SIZE));
    if (this.canvas.width === width && this.canvas.height === width) return;
    this.canvas.width = this.canvas.height = width;
    this.draw();
  }

  get localPlayer() {
    return this.players.find(player => player.id === this.localId) ?? null;
  }

  // Back to the solo title screen.
  reset() {
    this.role = 'local';
    this.match = 'solo';
    this.score = 0;
    this.level = 1;
    this.players = [this.makePlayer({ id: this.localId }, 0)];
    this.startLevel();
    this.mode = 'title';
    this.notify();
  }

  // roster: [{ id, name }] in slot order; the first MAX_PLAYERS take part.
  start({ match = 'solo', roster = [{ id: this.localId }], role = 'local' } = {}) {
    this.match = match;
    this.role = role;
    this.score = 0;
    this.level = 1;
    this.overReason = null;
    this.mode = 'playing';
    this.players = roster.slice(0, MAX_PLAYERS).map((member, slot) => this.makePlayer(member, slot));
    this.startLevel();
  }

  // Switch to rendering snapshots from a remote host.
  watch() {
    this.role = 'client';
    this.mode = 'connecting';
    this.players = [];
    this.enemies = [];
    this.bullets = [];
    this.bonuses = [];
    this.boss = null;
    this.fort = 0;
    this.fortPending = false;
    this.fortLevel = 0;
    this.baseArmor = 0;
    this.baseGun = 0;
    this.baseDestroyed = false;
    this.lastFx = 0;
    this.clearEffects();
    this.notify();
  }

  startLevel() {
    this.map = new Uint8Array(GRID * GRID);
    if (this.match === 'pvp') this.generateArena();
    else this.generateSector();
    // Each brick tile is four 8px quarters (bit order: top-left, top-right, bottom-left, bottom-right).
    this.bricks = this.map.map(tile => tile === WALL ? FULL_BRICK : 0);
    this.enemies = [];
    this.bullets = [];
    this.bonuses = [];
    this.nextId = 1;
    this.winner = null;
    this.bonusTimer = 5;
    this.fort = 0;
    this.fortPending = false;
    this.fortLevel = 0;
    this.baseArmor = 0;
    this.baseGun = 0;
    this.baseDestroyed = false;
    this.clearEffects();
    for (const player of this.players) {
      // Players knocked out in the previous sector rejoin with one tank.
      if (player.lives <= 0) player.lives = 1;
      player.roundKills = 0;
      this.placePlayer(player);
      player.shield = Math.max(player.shield, 1.8);
    }
    this.queue = this.match === 'pvp' ? [] : Array.from({ length: Math.min(8 + this.level * 2, 30) }, (_, i) => {
      const pick = Math.random();
      return {
        type: pick < 0.12 ? 'armor' : pick < 0.35 ? 'fast' : 'basic',
        x: [0, 96, 192][i % 3],
      };
    });
    this.boss = null;
    this.spawnTimer = 0.8;
    this.bossTimer = 0;
    this.touchMap();
    this.needsDraw = true;
    this.notify();
  }

  generateSector() {
    for (let y = 1; y < 10; y++) {
      for (let x = 0; x < GRID; x++) {
        if (Math.random() < 0.2) this.map[y * GRID + x] = Math.random() < 0.22 ? STEEL : WALL;
      }
    }
    this.placePatches(WATER, 1 + Math.floor(Math.random() * 2));
    this.placePatches(GRASS, 2 + Math.floor(Math.random() * 2));
    this.clearTiles(0, 0, 2, 2);
    this.clearTiles(6, 0, 1, 2);
    this.clearTiles(11, 0, 2, 2);
    this.clearTiles(3, 10, 7, 3);
    for (const [x, y] of FORT_CELLS) this.map[y * GRID + x] = WALL;
  }

  // Steel walls around the base; when the bonus runs out the bricks come back whole.
  fortify() {
    this.fort = FORT_TIME;
    this.setFort(STEEL);
  }

  pickFort() {
    this.fortify();
    this.fortLevel++;
    if (this.fortLevel >= BASE_ARMOR_LEVEL && !this.baseArmor) {
      this.baseArmor = 1;
      this.touchMap();
    }
    if (this.fortLevel === BASE_GUN_LEVEL) this.baseGun = BASE_GUN_DELAY;
  }

  updateBaseGun(dt) {
    if (this.fortLevel < BASE_GUN_LEVEL || this.baseDestroyed) return;
    this.baseGun -= dt;
    if (this.baseGun > 0) return;
    this.baseGun = BASE_GUN_DELAY;
    // Anywhere across the upper half: straight down would just hit the map edge.
    const angle = -Math.random() * Math.PI, speed = 180;
    this.bullets.push({
      x: BASE.x + 8, y: BASE.y + 8, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      owner: BASE, player: true, base: true, alive: true, damage: 1, steel: false,
    });
    this.explode('spark', BASE.x + 8, BASE.y + 4);
  }

  // repair: also rebuild bricks of the same type (used when the fort wears off).
  // Returns false when a tank kept some cell from changing.
  setFort(tile, repair = true) {
    let changed = false, skipped = false;
    for (const [col, row] of FORT_CELLS) {
      const cell = row * GRID + col;
      if (this.map[cell] === tile && (!repair || tile !== WALL || this.bricks[cell] === FULL_BRICK)) continue;
      // A tank parked in the gap would be sealed inside the wall; that cell is retried next frame.
      const occupied = [...this.players, ...this.enemies].some(t => t.alive && overlapsRect(col * TILE, row * TILE, TILE, TILE, t));
      if (occupied) {
        skipped = true;
        continue;
      }
      this.map[cell] = tile;
      this.bricks[cell] = tile === WALL ? FULL_BRICK : 0;
      changed = true;
    }
    if (changed) this.touchMap();
    return !skipped;
  }

  updateFort(dt) {
    if (this.fort <= 0) {
      // Cells blocked by a parked tank when the bonus ran out are rebuilt once it drives off.
      if (this.fortPending) this.fortPending = !this.setFort(WALL);
      return;
    }
    this.fort -= dt;
    if (this.fort <= 0) {
      this.fort = 0;
      this.fortPending = !this.setFort(WALL);
      return;
    }
    // Steel holds for the whole bonus (gaps fill in as soon as they clear);
    // it blinks to brick and back shortly before wearing off.
    const blinkBrick = this.fort < FORT_BLINK && Math.floor(this.fort * 4) % 2;
    this.setFort(blinkBrick ? WALL : STEEL, false);
  }

  // Point-symmetric arena so no corner is better than another.
  generateArena() {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < GRID; x++) {
        const pick = Math.random();
        const tile = pick < 0.16 ? WALL : pick < 0.21 ? STEEL : pick < 0.26 ? GRASS : pick < 0.28 ? WATER : 0;
        this.map[y * GRID + x] = tile;
        this.map[(GRID - 1 - y) * GRID + (GRID - 1 - x)] = tile;
      }
    }
    for (const [x, y] of PVP_SPAWNS) this.clearTiles(x / TILE - (x ? 1 : 0), y / TILE - (y ? 1 : 0), 2, 2);
  }

  placePatches(type, count) {
    for (let i = 0; i < count; i++) {
      const w = 2 + Math.floor(Math.random() * 2);
      const x = Math.floor(Math.random() * (GRID - w + 1)), y = 3 + Math.floor(Math.random() * 6);
      for (let row = y; row < y + 2; row++) {
        for (let col = x; col < x + w; col++) this.map[row * GRID + col] = type;
      }
    }
  }

  touchMap() {
    this.layerDirty = true;
    this.mapVersion++;
  }

  makeTank(x, y, direction, player = false, type = 'basic') {
    return {
      x, y, w: TILE, h: TILE, direction, player, type,
      hp: type === 'armor' ? 3 : 1,
      speed: player ? 58 : type === 'fast' ? 43 : type === 'armor' ? 21 : 28,
      cooldown: 0, turnTimer: 0.5 + Math.random(), tread: 0, flash: 0,
      alive: true, shield: player ? 1.8 : 0, boat: false, power: 0, speedLevel: 0,
    };
  }

  makePlayer({ id, name = '', bot = false }, slot) {
    return Object.assign(this.makeTank(0, 0, 'up', true), {
      id, name, slot, bot, lives: 3, kills: 0, roundKills: 0, respawn: 0,
      input: { direction: null, fire: false }, ai: null,
    });
  }

  placePlayer(player) {
    const spots = this.match === 'pvp' ? PVP_SPAWNS : COOP_SPAWNS;
    const ordered = [...spots.slice(player.slot), ...spots.slice(0, player.slot)];
    const probe = { x: -SIZE, y: -SIZE, w: TILE, h: TILE };
    const [x, y] = ordered.find(([sx, sy]) => !this.isBlocked(probe, sx, sy)) ?? ordered[0];
    Object.assign(player, { x, y, alive: true, cooldown: 0, direction: y < SIZE / 2 ? 'down' : 'up' });
  }

  clearTiles(x, y, w, h) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        this.map[row * GRID + col] = 0;
        // During generation the brick masks are rebuilt afterwards; mid-level they must be cleared too.
        if (this.bricks) this.bricks[row * GRID + col] = 0;
      }
    }
  }

  setDirection(direction) {
    this.input.direction = direction in DIRECTIONS ? direction : null;
  }

  setFire(fire) {
    this.input.fire = fire;
  }

  // inputs: { [playerId]: { direction, fire } } from remote players.
  setRemoteInputs(inputs) {
    for (const player of this.players) {
      if (player.id !== this.localId) player.input = inputs[player.id] ?? { direction: null, fire: false };
    }
  }

  togglePause() {
    if (this.role !== 'local') return;
    if (this.mode === 'playing') this.mode = 'paused';
    else if (this.mode === 'paused') this.mode = 'playing';
    this.notify();
  }

  continueAfterWin() {
    if (this.mode !== 'won' || this.match === 'pvp' || this.role === 'client') return;
    // Upgrades carry over to the next sector: the player objects survive startLevel.
    this.level++;
    this.mode = 'playing';
    this.startLevel();
  }
  // Solo checkpoint taken at the start of a sector: enough to rebuild the crew there later.
  exportProgress() {
    return {
      v: 1, level: this.level, score: this.score,
      players: this.players.map(({ name, bot, lives, power, boat, speedLevel }) => ({ name, bot, lives, power, boat, speedLevel })),
    };
  }

  resumeProgress(progress) {
    this.start({
      match: 'solo',
      roster: progress.players.map(p => ({ id: p.bot ? 'bot' : this.localId, name: p.name, bot: p.bot })),
    });
    this.level = progress.level;
    this.score = progress.score;
    progress.players.forEach((saved, slot) => Object.assign(this.players[slot], {
      lives: Math.max(1, saved.lives), power: saved.power, boat: saved.boat, speedLevel: saved.speedLevel ?? 0,
    }));
    this.startLevel();
  }


  // Snap the cross axis to a half-tile so tanks can enter one-tile corridors.
  alignTo(entity, axis) {
    const target = Math.round(entity[axis] / 8) * 8;
    if (target === entity[axis]) return;
    const x = axis === 'x' ? target : entity.x;
    const y = axis === 'y' ? target : entity.y;
    if (!this.isBlocked(entity, x, y)) entity[axis] = target;
  }

  move(entity, direction, distance) {
    const dir = DIRECTIONS[direction];
    if (!dir) return false;
    entity.direction = direction;
    this.alignTo(entity, dir.x === 0 ? 'x' : 'y');
    const steps = Math.ceil(distance / 2);
    const step = distance / steps;
    for (let i = 0; i < steps; i++) {
      const x = entity.x + dir.x * step;
      const y = entity.y + dir.y * step;
      if (this.isBlocked(entity, x, y)) return false;
      entity.x = x;
      entity.y = y;
      entity.tread += step;
    }
    return true;
  }

  isBlocked(entity, x, y) {
    const { w, h } = entity;
    if (x < 0 || y < 0 || x + w > SIZE || y + h > SIZE) return true;
    if (this.match !== 'pvp' && overlapsRect(x, y, w, h, BASE)) return true;
    const left = Math.floor(x / TILE), right = Math.floor((x + w - 1) / TILE);
    const top = Math.floor(y / TILE), bottom = Math.floor((y + h - 1) / TILE);
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const cell = row * GRID + col;
        const tile = this.map[cell];
        if (tile === WALL) {
          if (this.brickOverlaps(cell, x, y, w, h)) return true;
        } else if (tile && tile !== GRASS && !(tile === WATER && entity.boat)) return true;
      }
    }
    if (this.blocks(entity, x, y, this.boss)) return true;
    for (const other of this.players) {
      if (this.blocks(entity, x, y, other)) return true;
    }
    for (const other of this.enemies) {
      if (this.blocks(entity, x, y, other)) return true;
    }
    return false;
  }

  inGrass(tank) {
    const cx = Math.floor((tank.x + 8) / TILE), cy = Math.floor((tank.y + 8) / TILE);
    return this.map[cy * GRID + cx] === GRASS;
  }

  brickOverlaps(cell, x, y, w, h) {
    const tx = (cell % GRID) * TILE, ty = Math.floor(cell / GRID) * TILE;
    for (let q = 0; q < 4; q++) {
      if (!(this.bricks[cell] & (1 << q))) continue;
      const quarter = { x: tx + (q & 1) * 8, y: ty + (q >> 1) * 8, w: 8, h: 8 };
      if (overlapsRect(x, y, w, h, quarter)) return true;
    }
    return false;
  }

  // Bodies that already overlap may separate; otherwise they would lock each other in place.
  blocks(entity, x, y, other) {
    return Boolean(other) && other !== entity && other.alive !== false &&
      overlapsRect(x, y, entity.w, entity.h, other) &&
      !overlapsRect(entity.x, entity.y, entity.w, entity.h, other);
  }

  fire(tank) {
    // Power 1: faster shells, 2: a shell hits like two, 3: like three and pierces steel.
    const power = tank.player ? tank.power : 0;
    if (!tank.alive || tank.cooldown > 0 || this.bullets.some(b => b.owner === tank)) return;
    const dir = DIRECTIONS[tank.direction];
    const speed = !tank.player ? 112 : power >= 1 ? 240 : 180;
    this.bullets.push({
      x: tank.x + 8 + dir.x * 9, y: tank.y + 8 + dir.y * 9,
      vx: dir.x * speed, vy: dir.y * speed,
      owner: tank, player: tank.player, alive: true,
      damage: Math.max(1, power), steel: power >= MAX_POWER,
    });
    tank.cooldown = tank.player ? 0.24 : 0.9 + Math.random() * 0.8;
  }

  update(dt) {
    if (this.role === 'client') {
      this.updateClient(dt);
      return;
    }
    if (this.mode !== 'playing') return;
    this.frame += dt;
    for (const player of this.players) this.updatePlayer(player, dt);

    this.bonusTimer -= dt;
    if (this.bonusTimer <= 0) {
      this.spawnBonus();
      this.bonusTimer = 8 + Math.random() * 5;
    }
    if (this.match !== 'pvp') {
      this.spawnTimer -= dt;
      if (this.queue.length && this.spawnTimer <= 0 && this.enemies.length < 4) {
        const next = this.queue.shift();
        const occupied = [...this.players, ...this.enemies].some(t => t.alive && overlapsRect(next.x, 0, TILE, TILE, t));
        if (!occupied) {
          this.enemies.push(Object.assign(this.makeTank(next.x, 0, 'down', false, next.type), { id: this.nextId++ }));
        } else this.queue.push(next);
        this.spawnTimer = 1.2;
      }
      for (const enemy of this.enemies) this.updateEnemy(enemy, dt);
      this.enemies = this.enemies.filter(enemy => enemy.alive);
      this.updateBoss(dt);
    }
    this.updateBullets(dt);
    if (this.mode !== 'playing') return;
    this.updateBonuses(dt);
    this.updateFort(dt);
    this.updateBaseGun(dt);

    if (this.match !== 'pvp') {
      if (!this.queue.length && !this.enemies.length && !this.boss && this.bossTimer <= 0) {
        this.bossTimer = 1.3;
      }
      if (this.bossTimer > 0) {
        this.bossTimer -= dt;
        if (this.bossTimer <= 0 && !this.queue.length && !this.enemies.length && !this.boss) {
          // The fortress lands on rows 1-3; clear them so walls don't hide it or swallow its shots.
          this.clearTiles(0, 1, GRID, 3);
          this.touchMap();
          this.boss = this.makeBoss();
        }
      }
      if (this.boss && this.boss.hp <= 0 && !this.boss.dying) {
        // The fortress goes up in a chain of blasts before the sector counts as won;
        // its last shells fizzle so nothing can still reach the base meanwhile.
        this.boss.dying = 1.4;
        this.explode('boss', this.boss.x + this.boss.w / 2, this.boss.y + this.boss.h / 2);
        for (const bullet of this.bullets) {
          if (bullet.player) continue;
          bullet.alive = false;
          this.explode('spark', bullet.x, bullet.y);
        }
        this.bullets = this.bullets.filter(bullet => bullet.alive);
      }
      if (this.boss?.dying) {
        this.boss.dying -= dt;
        if (this.boss.dying <= 0) {
          this.boss = null;
          this.score += 2000;
          this.mode = 'won';
          this.notify();
        }
      }
    }

    if (this.frame - this.lastUi > 0.15) {
      this.lastUi = this.frame;
      this.notify();
    }
  }

  updatePlayer(player, dt) {
    if (!player.alive) {
      if (player.lives <= 0) return;
      player.respawn -= dt;
      if (player.respawn <= 0) {
        Object.assign(player, { power: 0, boat: false, speedLevel: 0, shield: 2 });
        this.placePlayer(player);
      }
      return;
    }
    const input = player.bot ? this.updateBot(player, dt) : player.id === this.localId ? this.input : player.input;
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.shield = Math.max(0, player.shield - dt);
    if (input.direction) this.move(player, input.direction, player.speed * (1 + player.speedLevel * 0.25) * dt);
    if (input.fire) this.fire(player);
  }

  updateEnemy(enemy, dt) {
    if (!enemy.alive) return;
    enemy.cooldown = Math.max(0, enemy.cooldown - dt);
    enemy.flash = Math.max(0, enemy.flash - dt);
    enemy.turnTimer -= dt;
    const moved = this.move(enemy, enemy.direction, enemy.speed * dt);
    if (!moved || enemy.turnTimer <= 0) {
      const options = ENEMY_TURNS[enemy.direction];
      enemy.direction = options[Math.floor(Math.random() * options.length)];
      enemy.turnTimer = 0.7 + Math.random() * 1.8;
    }
    if (Math.random() < dt * 0.9) this.fire(enemy);
  }

  // Every round the boss gets tougher and sneakier:
  // 2+ jinks back and forth, 3+ aims its triple shot, 4+ fires double volleys (6+ triple),
  // 5+ rebuilds lost turrets unless the hull is finished off in time.
  makeBoss() {
    const level = this.level, extra = this.players.length - 1;
    const gunHp = 3 + level + extra * 2;
    const hp = 6 + level * 2 + extra * 3;
    return {
      x: (SIZE - BOSS_W) / 2, y: 18, w: BOSS_W, h: BOSS_H, hp, maxHp: hp,
      direction: Math.random() < 0.5 ? 1 : -1, cooldown: 1.5, volleys: 0, turnTimer: 2, flash: 0,
      guns: BOSS_GUNS.map((dx, i) => ({ dx, hp: gunHp, maxHp: gunHp, angle: Math.PI / 2, cooldown: 1 + i * 0.6, rebuild: 0, flash: 0 })),
    };
  }

  bossArmed(boss) {
    return boss.guns.some(gun => gun.hp > 0);
  }

  // Parts that can take damage right now: the turrets first, then the hull.
  bossTargets(boss) {
    if (this.bossArmed(boss)) return boss.guns.filter(gun => gun.hp > 0).map(gun => bossColumn(boss, gun.dx));
    return [boss];
  }

  bossShot(x, y, angle, speed) {
    this.bullets.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, owner: this.boss, player: false, alive: true });
  }

  updateBoss(dt) {
    if (!this.boss || this.boss.dying) return;
    const boss = this.boss, level = this.level;
    const armed = this.bossArmed(boss);
    const targets = this.players.filter(p => p.alive);
    boss.flash = Math.max(0, boss.flash - dt);
    // Once disarmed it speeds up to make the hull harder to hit.
    const speed = Math.min(60, 16 + level * 3) * (armed ? 1 : 1.5);
    boss.x += boss.direction * speed * dt;
    if (boss.x < 2) {
      boss.x = 2;
      boss.direction = 1;
    } else if (boss.x + boss.w > SIZE - 2) {
      boss.x = SIZE - 2 - boss.w;
      boss.direction = -1;
    }
    if (level >= 2) {
      boss.turnTimer -= dt;
      if (boss.turnTimer <= 0) {
        if (Math.random() < 0.6) boss.direction *= -1;
        boss.turnTimer = Math.max(0.6, 3 - level * 0.25) + Math.random() * 1.5;
      }
    }
    const shellSpeed = Math.min(130, 74 + level * 6);
    for (const gun of boss.guns) {
      gun.flash = Math.max(0, gun.flash - dt);
      if (gun.hp <= 0) {
        if (level < 5) continue;
        gun.rebuild -= dt;
        if (gun.rebuild <= 0) Object.assign(gun, { hp: Math.ceil(gun.maxHp / 2), cooldown: 1.2 });
        continue;
      }
      // Turrets swing toward the nearest tank; they turn faster every round.
      const cx = boss.x + gun.dx, cy = boss.y + 13;
      const want = clampAim(nearestAngle({ x: cx, y: cy }, targets));
      const turn = (1.2 + level * 0.4) * dt;
      const diff = Math.atan2(Math.sin(want - gun.angle), Math.cos(want - gun.angle));
      gun.angle += Math.max(-turn, Math.min(turn, diff));
      gun.cooldown -= dt;
      if (gun.cooldown <= 0 && targets.length) {
        this.bossShot(cx + Math.cos(gun.angle) * 10, cy + Math.sin(gun.angle) * 10, gun.angle, shellSpeed);
        gun.cooldown = Math.max(0.7, 2.3 - level * 0.15) + Math.random() * 0.4;
      }
    }
    if (armed) return;
    // Both turrets down: the hull opens fire itself, three shells at a time.
    boss.cooldown -= dt;
    if (boss.cooldown > 0) return;
    const cx = boss.x + BOSS_CORE, cy = boss.y + 16;
    const aim = level >= 3 ? clampAim(nearestAngle({ x: cx, y: cy }, targets)) : Math.PI / 2;
    for (const spread of [-0.35, 0, 0.35]) this.bossShot(cx + Math.cos(aim) * 11, cy + Math.sin(aim) * 11, aim + spread, shellSpeed);
    const volleys = level >= 6 ? 3 : level >= 4 ? 2 : 1;
    boss.volleys++;
    if (boss.volleys < volleys) boss.cooldown = 0.28;
    else {
      boss.volleys = 0;
      boss.cooldown = Math.max(0.9, 2.1 - level * 0.1);
    }
  }

  hitBoss(boss, x, y, damage) {
    const gun = boss.guns.find(g => g.hp > 0 && Math.abs(boss.x + g.dx - x) <= 5);
    if (gun) {
      gun.hp -= damage;
      gun.flash = 0.12;
      if (gun.hp <= 0) {
        gun.hp = 0;
        gun.rebuild = Math.max(6, 15 - this.level);
        this.score += 500;
        this.explode('tank', boss.x + gun.dx, boss.y + 13);
      } else this.explode('spark', x, y);
      return;
    }
    // While a turret still stands the hull shrugs shells off.
    this.explode('spark', x, y);
    if (this.bossArmed(boss)) return;
    boss.hp -= damage;
    boss.flash = 0.12;
  }

  updateBullets(dt) {
    for (const bullet of this.bullets) {
      if (this.mode !== 'playing') break;
      if (!bullet.alive) continue;
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      if (bullet.x < 0 || bullet.y < 0 || bullet.x >= SIZE || bullet.y >= SIZE) {
        bullet.alive = false;
        this.explode('spark', Math.min(SIZE - 1, Math.max(1, bullet.x)), Math.min(SIZE - 1, Math.max(1, bullet.y)));
        continue;
      }
      const col = Math.floor(bullet.x / TILE), row = Math.floor(bullet.y / TILE);
      const cell = row * GRID + col;
      // Shells fly over water and through grass.
      const tile = bullet.base && this.isFort(cell) ? 0 : this.map[cell];
      if (tile === WALL) {
        const q = (Math.floor(bullet.y / 8) & 1) * 2 + (Math.floor(bullet.x / 8) & 1);
        if (this.bricks[cell] & (1 << q)) {
          // A plain hit knocks out the half of the brick facing the shell; heavier shells take it all.
          const half = bullet.vx ? (q & 1 ? 0b1010 : 0b0101) : (q & 2 ? 0b1100 : 0b0011);
          this.bricks[cell] &= bullet.damage > 1 ? 0 : ~half;
          if (!this.bricks[cell]) this.map[cell] = 0;
          this.touchMap();
          bullet.alive = false;
          this.explode('brick', bullet.x, bullet.y);
          continue;
        }
      } else if (tile === STEEL) {
        if (bullet.steel) {
          this.map[cell] = 0;
          this.touchMap();
        }
        bullet.alive = false;
        this.explode(bullet.steel ? 'brick' : 'spark', bullet.x, bullet.y);
        continue;
      }
      const hx = bullet.x - 2, hy = bullet.y - 2;
      const target = this.players.find(p => p.alive && p !== bullet.owner && overlapsRect(hx, hy, 4, 4, p));
      if (!bullet.player) {
        if (target) {
          bullet.alive = false;
          this.hitPlayer(target);
          continue;
        }
        if (overlapsRect(hx, hy, 4, 4, BASE)) {
          bullet.alive = false;
          if (this.baseArmor > 0) {
            this.baseArmor--;
            this.touchMap();
            this.explode('brick', bullet.x, bullet.y);
            continue;
          }
          this.baseDestroyed = true;
          this.touchMap();
          this.explode('base', BASE.x + 8, BASE.y + 8);
          this.overReason = 'base';
          this.mode = 'over';
          this.notify();
          continue;
        }
      } else {
        // Teammates soak up friendly shells; in PvP every other tank is fair game.
        if (target) {
          bullet.alive = false;
          if (this.match === 'pvp') this.hitPlayer(target, bullet.owner);
          else this.explode('spark', bullet.x, bullet.y);
          continue;
        }
        const enemy = this.enemies.find(item => item.alive && overlapsRect(hx, hy, 4, 4, item));
        if (enemy) {
          bullet.alive = false;
          enemy.hp -= bullet.damage;
          enemy.flash = 0.12;
          if (enemy.hp <= 0) {
            enemy.alive = false;
            if (!bullet.base) {
              bullet.owner.kills++;
              bullet.owner.roundKills++;
            }
            this.score += enemy.type === 'armor' ? 400 : enemy.type === 'fast' ? 200 : 100;
            this.explode('tank', enemy.x + 8, enemy.y + 8);
          } else this.explode('spark', bullet.x, bullet.y);
          continue;
        }
        if (this.boss && !this.boss.dying && overlapsRect(hx, hy, 4, 4, this.boss)) {
          bullet.alive = false;
          this.hitBoss(this.boss, bullet.x, bullet.y, bullet.damage);
        }
      }
    }
    this.collideBullets(dt);
    this.bullets = this.bullets.filter(bullet => bullet.alive);
  }

  // Shells from different tanks cancel each other out. Checks the closest approach
  // over the whole frame so fast head-on shells can't slip past one another.
  collideBullets(dt) {
    for (let i = 0; i < this.bullets.length; i++) {
      const a = this.bullets[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.bullets.length; j++) {
        const b = this.bullets[j];
        if (!b.alive || a.owner === b.owner) continue;
        const rx = a.x - b.x, ry = a.y - b.y;
        const vx = a.vx - b.vx, vy = a.vy - b.vy;
        const v2 = vx * vx + vy * vy;
        const t = v2 ? Math.min(dt, Math.max(0, (rx * vx + ry * vy) / v2)) : 0;
        const dx = rx - vx * t, dy = ry - vy * t;
        if (dx * dx + dy * dy >= 36) continue;
        a.alive = false;
        b.alive = false;
        this.explode('spark', (a.x + b.x) / 2, (a.y + b.y) / 2);
        break;
      }
    }
  }

  hitPlayer(player, shooter = null) {
    if (player.shield > 0) {
      this.explode('spark', player.x + 8, player.y + 8);
      return;
    }
    this.explode('tank', player.x + 8, player.y + 8);
    player.alive = false;
    player.lives--;
    player.respawn = 1.2;
    if (shooter) {
      shooter.kills++;
      shooter.roundKills++;
    }
    this.checkStanding();
  }

  // A player who left a network game drops out for the rest of the round.
  retirePlayer(id) {
    const player = this.players.find(p => p.id === id);
    if (!player || player.lives <= 0 || this.mode !== 'playing') return;
    player.alive = false;
    player.lives = 0;
    this.checkStanding();
  }

  checkStanding() {
    const standing = this.players.filter(p => p.lives > 0);
    if (this.match === 'pvp') {
      if (this.players.length > 1 && standing.length <= 1) {
        this.winner = standing[0]?.id ?? null;
        this.mode = 'won';
      }
    } else if (!standing.length) {
      this.overReason = 'crew';
      this.mode = 'over';
    }
    this.notify();
  }

  // Second chance after a lost solo run: every tank is back with at least one life, the base
  // is rebuilt and walled in steel for a while, and shells still in flight are cleared.
  revive() {
    if (this.mode !== 'over' || this.role !== 'local' || this.match !== 'solo') return false;
    for (const player of this.players) {
      if (player.lives <= 0) player.lives = 1;
      if (!player.alive) {
        player.respawn = 0;
        this.placePlayer(player);
      }
      player.shield = Math.max(player.shield, 3);
    }
    this.bullets = [];
    this.baseDestroyed = false;
    this.overReason = null;
    this.fortify();
    this.touchMap();
    this.mode = 'playing';
    this.notify();
    return true;
  }

  // Upgrades turn up every few seconds on a random open tile (grass counts, so some are hidden).
  spawnBonus() {
    if (this.bonuses.length >= 3) return;
    const free = [];
    for (let i = 0; i < this.map.length; i++) {
      const x = (i % GRID) * TILE, y = Math.floor(i / GRID) * TILE;
      if (this.map[i] && this.map[i] !== GRASS) continue;
      if (this.match !== 'pvp' && (overlapsRect(x, y, TILE, TILE, BASE) || this.isFort(i))) continue;
      if (this.bonuses.some(bonus => bonus.x === x && bonus.y === y)) continue;
      free.push([x, y]);
    }
    if (!free.length) return;
    const [x, y] = free[Math.floor(Math.random() * free.length)];
    const kinds = ['star', 'star', 'shield', 'life'];
    if (this.players.some(player => !player.boat)) kinds.push('boat');
    if (this.players.some(player => player.speedLevel < MAX_SPEED_LEVEL)) kinds.push('speed');
    if (this.match !== 'pvp' && this.fort <= 0) kinds.push('fort');
    this.bonuses.push({ x, y, kind: kinds[Math.floor(Math.random() * kinds.length)], time: 10 });
  }

  updateBonuses(dt) {
    for (const bonus of this.bonuses) {
      bonus.time -= dt;
      if (bonus.time <= 0) continue;
      const player = this.players.find(p => p.alive && overlapsRect(bonus.x, bonus.y, 16, 16, p));
      if (!player) continue;
      bonus.time = 0;
      if (bonus.kind === 'life') player.lives = Math.min(5, player.lives + 1);
      else if (bonus.kind === 'boat') player.boat = true;
      else if (bonus.kind === 'star') player.power = Math.min(MAX_POWER, player.power + 1);
      else if (bonus.kind === 'speed') player.speedLevel = Math.min(MAX_SPEED_LEVEL, player.speedLevel + 1);
      else if (bonus.kind === 'fort') this.pickFort();
      else player.shield = 8;
      this.score += 250;
    }
    this.bonuses = this.bonuses.filter(bonus => bonus.time > 0);
  }

  notify() {
    this.needsDraw = true;
    const me = this.localPlayer;
    this.onChange({
      mode: this.mode, match: this.match, role: this.role,
      score: this.score, level: this.level,
      lives: me?.lives ?? 0, kills: me?.kills ?? 0, spectator: !me,
      enemies: this.role === 'client' ? this.enemiesLeft ?? 0 : this.queue.length + this.enemies.length,
      boss: this.boss ? {
        hp: Math.max(0, this.boss.hp) + this.boss.guns.reduce((sum, gun) => sum + gun.hp, 0),
        maxHp: this.boss.maxHp + this.boss.guns.reduce((sum, gun) => sum + gun.maxHp, 0),
        guns: this.boss.guns.filter(gun => gun.hp > 0).length,
      } : null,
      crew: this.players.map(({ id, name, slot, bot, lives, kills, roundKills, alive }) => ({ id, name, slot, bot, lives, kills, roundKills, alive })),
      winner: this.winner ?? null,
      fort: Math.ceil(this.fort),
      overReason: this.overReason ?? null,
    });
  }

  // --- Bot player ----------------------------------------------------------
  // Plans a route over the tile grid every few tenths of a second, shoots whatever lines up
  // with its gun, blasts bricks in its way and never touches the bricks around the base.

  updateBot(bot, dt) {
    const ai = bot.ai ??= { think: 0, path: [], stuck: 0, wander: 0, wanderDir: null, duel: 0, lastX: bot.x, lastY: bot.y };
    ai.think -= dt;
    if (ai.think <= 0) {
      ai.think = 0.3;
      ai.path = this.planBotPath(bot);
    }
    const aim = ai.wander > 0 ? null : this.botAim(bot);
    if (aim) {
      // Two tanks firing down the same lane cancel each other's shells forever,
      // so a stand-off that drags on ends with a sidestep out of the line of fire.
      ai.duel += dt;
      if (ai.duel > 1 + Math.random()) {
        ai.duel = 0;
        ai.wander = 0.35 + Math.random() * 0.3;
        const side = DIRECTIONS[aim].x ? ['up', 'down'] : ['left', 'right'];
        ai.wanderDir = side[Math.floor(Math.random() * 2)];
      } else {
        // Turn in place and fire rather than driving into the target.
        bot.direction = aim;
        ai.lastX = bot.x;
        ai.lastY = bot.y;
        return { direction: null, fire: true };
      }
    } else if (ai.wander <= 0) ai.duel = 0;
    let direction;
    if (ai.wander > 0) {
      ai.wander -= dt;
      direction = ai.wanderDir;
    } else direction = this.botStep(bot, ai.path);
    const moved = Math.abs(bot.x - ai.lastX) + Math.abs(bot.y - ai.lastY) > 0.01;
    ai.lastX = bot.x;
    ai.lastY = bot.y;
    if (direction && !moved) {
      ai.stuck += dt;
      if (ai.stuck > 0.5) {
        ai.stuck = 0;
        ai.wander = 0.4 + Math.random() * 0.4;
        ai.wanderDir = DIR_NAMES[Math.floor(Math.random() * DIR_NAMES.length)];
      }
    } else ai.stuck = 0;
    return { direction, fire: Boolean(direction) && this.brickAhead(bot, direction) };
  }

  isFort(cell) {
    const col = cell % GRID, row = Math.floor(cell / GRID);
    return this.match !== 'pvp' && col >= 5 && col <= 7 && row >= 10;
  }

  cellAt(x, y) {
    return Math.floor(y / TILE) * GRID + Math.floor(x / TILE);
  }

  botGoal(bot) {
    const near = list => list.reduce((best, item) => {
      const d = Math.abs(item.x - bot.x) + Math.abs(item.y - bot.y);
      return !best || d < best.d ? { item, d } : best;
    }, null);
    const cellOf = item => this.cellAt(item.x + 8, item.y + 8);
    if (this.match === 'pvp') {
      const foe = near(this.players.filter(p => p !== bot && p.alive));
      return foe ? cellOf(foe.item) : null;
    }
    const enemies = this.enemies.filter(enemy => enemy.alive);
    const threat = enemies.filter(enemy => enemy.y > 112).sort((a, b) => b.y - a.y)[0];
    if (threat) return cellOf(threat);
    const bonus = near(this.bonuses);
    if (bonus && bonus.d < 96) return cellOf(bonus.item);
    if (this.boss) {
      const part = this.bossTargets(this.boss)[0];
      return 5 * GRID + Math.floor((part.x + part.w / 2) / TILE);
    }
    const enemy = near(enemies);
    if (enemy) return cellOf(enemy.item);
    if (bonus) return cellOf(bonus.item);
    return 9 * GRID + 6;
  }

  // Cheapest route on the tile grid: bricks cost extra (they have to be shot through),
  // steel and water are closed unless the bot can pierce or float.
  planBotPath(bot) {
    const goal = this.botGoal(bot);
    const start = this.cellAt(bot.x + 8, bot.y + 8);
    if (goal === null || goal === start) return [];
    const cost = cell => {
      const tile = this.map[cell];
      if (this.isFort(cell) && tile) return Infinity;
      if (this.match !== 'pvp' && cell === this.cellAt(BASE.x, BASE.y)) return Infinity;
      if (tile === WALL) return 3;
      if (tile === STEEL) return bot.power >= MAX_POWER ? 4 : Infinity;
      if (tile === WATER) return bot.boat ? 1 : Infinity;
      return 1;
    };
    const size = GRID * GRID;
    const dist = new Float32Array(size).fill(Infinity);
    const prev = new Int16Array(size).fill(-1);
    const done = new Uint8Array(size);
    dist[start] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < size; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === goal) break;
      done[u] = 1;
      const col = u % GRID, row = Math.floor(u / GRID);
      for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const c = col + dc, r = row + dr;
        if (c < 0 || r < 0 || c >= GRID || r >= GRID) continue;
        const v = r * GRID + c;
        const step = v === goal ? 1 : cost(v);
        if (dist[u] + step < dist[v]) {
          dist[v] = dist[u] + step;
          prev[v] = u;
        }
      }
    }
    if (prev[goal] < 0) return [];
    const path = [];
    for (let cell = goal; cell !== start; cell = prev[cell]) path.unshift(cell);
    return path;
  }

  botStep(bot, path) {
    // move() advances in sub-steps of up to 2px, so a waypoint counts as reached within that.
    while (path.length && Math.abs((path[0] % GRID) * TILE - bot.x) < 2 && Math.abs(Math.floor(path[0] / GRID) * TILE - bot.y) < 2) {
      path.shift();
    }
    if (!path.length) return null;
    const dx = (path[0] % GRID) * TILE - bot.x;
    const dy = Math.floor(path[0] / GRID) * TILE - bot.y;
    // Line up on the smaller offset first so the tank fits into one-tile corridors.
    const horizontal = Math.abs(dy) < 2 || (Math.abs(dx) >= 2 && Math.abs(dx) < Math.abs(dy));
    if (horizontal) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  // Direction of a target lined up with the bot and within reach, if any.
  botAim(bot) {
    const cx = bot.x + 8, cy = bot.y + 8;
    const targets = this.match === 'pvp'
      ? this.players.filter(p => p !== bot && p.alive && !this.inGrass(p))
      : [...this.enemies.filter(enemy => enemy.alive), ...(this.boss && !this.boss.dying ? this.bossTargets(this.boss) : [])];
    let best = null;
    for (const target of targets) {
      let direction = null, distance = 0;
      if (cx > target.x + 2 && cx < target.x + target.w - 2) {
        direction = target.y + target.h / 2 < cy ? 'up' : 'down';
        distance = Math.abs(target.y + target.h / 2 - cy);
      } else if (cy > target.y + 2 && cy < target.y + target.h - 2) {
        direction = target.x + target.w / 2 < cx ? 'left' : 'right';
        distance = Math.abs(target.x + target.w / 2 - cx);
      }
      if (!direction || distance > 140 || (best && best.distance <= distance)) continue;
      if (this.lineClear(bot, direction, distance)) best = { direction, distance };
    }
    return best?.direction ?? null;
  }

  lineClear(bot, direction, distance) {
    const dir = DIRECTIONS[direction];
    for (let d = 8; d < distance; d += 4) {
      const cell = this.cellAt(bot.x + 8 + dir.x * d, bot.y + 8 + dir.y * d);
      const tile = this.map[cell];
      if (tile === STEEL && (bot.power < MAX_POWER || this.isFort(cell))) return false;
      if (tile === WALL && this.isFort(cell)) return false;
    }
    return true;
  }

  brickAhead(bot, direction) {
    const dir = DIRECTIONS[direction];
    for (const side of [-5, 0, 5]) {
      const x = bot.x + 8 + dir.x * 11 + dir.y * side;
      const y = bot.y + 8 + dir.y * 11 + dir.x * side;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const cell = this.cellAt(x, y);
      if (this.map[cell] === STEEL && bot.power >= MAX_POWER && !this.isFort(cell)) return true;
      if (this.map[cell] === WALL && !this.isFort(cell)) {
        const q = (Math.floor(y / 8) & 1) * 2 + (Math.floor(x / 8) & 1);
        if (this.bricks[cell] & (1 << q)) return true;
      }
    }
    return false;
  }

  // --- Network state -------------------------------------------------------

  snapshot() {
    return {
      m: this.mode, t: this.match, l: this.level, s: this.score, v: this.mapVersion,
      q: this.queue.length + this.enemies.length, w: this.winner ?? '',
      p: this.players.map(p => [
        p.id, p.name, p.slot, round(p.x), round(p.y), DIR_NAMES.indexOf(p.direction), p.alive ? 1 : 0,
        p.shield > 0 ? 1 : 0, p.boat ? 1 : 0, p.power, p.lives, p.kills, Math.floor(p.tread) % 3, p.roundKills, p.speedLevel,
      ]),
      e: this.enemies.map(e => [
        e.id, round(e.x), round(e.y), DIR_NAMES.indexOf(e.direction), ENEMY_TYPES.indexOf(e.type),
        e.hp, e.flash > 0 ? 1 : 0, Math.floor(e.tread) % 3,
      ]),
      b: this.bullets.map(b => [round(b.x), round(b.y), b.vx, b.vy, b.player ? b.damage : 0]),
      o: this.bonuses.map(o => [o.x, o.y, BONUS_KINDS.indexOf(o.kind)]),
      B: this.boss ? [
        round(this.boss.x), round(this.boss.y), this.boss.hp, this.boss.maxHp, this.boss.flash > 0 ? 1 : 0,
        ...this.boss.guns.flatMap(gun => [gun.hp, gun.maxHp, Math.round(gun.angle * 100) / 100, gun.flash > 0 ? 1 : 0]),
      ] : 0,
      x: this.fxLog.map(fx => [fx.id, FX_KINDS.indexOf(fx.kind), fx.x, fx.y]),
      F: Math.ceil(this.fort),
      D: this.baseDestroyed ? 1 : 0,
      A: this.baseArmor,
      G: this.fortLevel >= BASE_GUN_LEVEL ? 1 : 0,
    };
  }

  applySnapshot(snap) {
    if (this.role !== 'client' || !snap) return;
    const previousMode = this.mode;
    this.mode = snap.m;
    if (this.match !== snap.t) this.layerDirty = true;
    this.match = snap.t;
    this.level = snap.l;
    this.score = snap.s;
    this.enemiesLeft = snap.q;
    this.winner = snap.w || null;
    // Tanks glide toward their reported position in updateClient instead of jumping.
    const sync = (list, id) => list.find(item => item.id === id);
    this.players = (snap.p ?? []).map(([id, name, slot, x, y, dir, alive, shield, boat, power, lives, kills, tread, roundKills, speedLevel = 0]) => {
      const player = sync(this.players, id) ?? Object.assign(this.makePlayer({ id, name }, slot), { x, y });
      return Object.assign(player, {
        name, slot, tx: x, ty: y, direction: DIR_NAMES[dir], alive: Boolean(alive), shield, boat: Boolean(boat),
        power, lives, kills, tread, roundKills, speedLevel,
      });
    });
    this.enemies = (snap.e ?? []).map(([id, x, y, dir, type, hp, flash, tread]) => {
      const enemy = sync(this.enemies, id) ?? Object.assign(this.makeTank(x, y, 'down', false, ENEMY_TYPES[type]), { id });
      return Object.assign(enemy, { tx: x, ty: y, direction: DIR_NAMES[dir], hp, flash, tread });
    });
    this.bullets = (snap.b ?? []).map(([x, y, vx, vy, damage]) => ({ x, y, vx, vy, player: damage > 0, damage: Math.max(1, damage) }));
    this.bonuses = (snap.o ?? []).map(([x, y, kind]) => ({ x, y, kind: BONUS_KINDS[kind] }));
    if (snap.B) {
      const [x, y, hp, maxHp, flash, ...guns] = snap.B;
      this.boss = Object.assign(this.boss ?? { x, y, w: BOSS_W, h: BOSS_H }, {
        tx: x, ty: y, hp, maxHp, flash, dying: hp <= 0,
        guns: BOSS_GUNS.map((dx, i) => {
          const [gunHp = 0, gunMax = 1, angle = Math.PI / 2, gunFlash = 0] = guns.slice(i * 4, i * 4 + 4);
          return { dx, hp: gunHp, maxHp: gunMax, angle, flash: gunFlash };
        }),
      });
    } else this.boss = null;
    // Blasts stay in a few consecutive snapshots; play each one once.
    for (const [id, kind, x, y] of snap.x ?? []) {
      if (id <= this.lastFx) continue;
      this.lastFx = id;
      this.spawnEffect(FX_KINDS[kind], x, y);
    }
    this.fort = snap.F ?? 0;
    const armor = snap.A ?? 0, level = snap.G ? BASE_GUN_LEVEL : 0;
    if (Boolean(snap.D) !== this.baseDestroyed || armor !== this.baseArmor || level !== this.fortLevel) {
      this.baseDestroyed = Boolean(snap.D);
      this.baseArmor = armor;
      this.fortLevel = level;
      this.layerDirty = true;
    }
    this.needsDraw = true;
    if (previousMode !== this.mode || this.frame - this.lastUi > 0.15) {
      this.lastUi = this.frame;
      this.notify();
    }
  }

  updateClient(dt) {
    this.frame += dt;
    const k = Math.min(1, dt * 18);
    for (const item of [...this.players, ...this.enemies, this.boss]) {
      if (!item || item.tx === undefined) continue;
      if (Math.abs(item.tx - item.x) > 24 || Math.abs(item.ty - item.y) > 24) {
        item.x = item.tx;
        item.y = item.ty;
      } else {
        item.x += (item.tx - item.x) * k;
        item.y += (item.ty - item.y) * k;
      }
    }
    // Shells move in straight lines, so extrapolate them between snapshots.
    for (const bullet of this.bullets) {
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
    }
  }

  // One printable character per tile: type in the high bits, brick quarters in the low four.
  encodeMap() {
    let text = '';
    for (let i = 0; i < this.map.length; i++) text += String.fromCharCode(48 + this.map[i] * 16 + this.bricks[i]);
    return text;
  }

  applyMap(text) {
    if (this.role !== 'client' || typeof text !== 'string' || text.length !== GRID * GRID) return;
    this.map = new Uint8Array(GRID * GRID);
    this.bricks = new Uint8Array(GRID * GRID);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i) - 48;
      this.map[i] = code >> 4;
      this.bricks[i] = code & 15;
    }
    this.layerDirty = true;
    this.needsDraw = true;
  }

  // --- Drawing -------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const width = this.canvas.width;
    if (this.layer.width !== width || this.layer.height !== width) {
      this.layer.width = this.layer.height = width;
      this.grassLayer.width = this.grassLayer.height = width;
      this.layerDirty = true;
    }
    if (this.layerDirty) this.drawLayer(width);
    const scale = width / SIZE;
    // Screen shake moves the whole field by whole device pixels.
    let ox = 0, oy = 0;
    if (this.shakeTime > 0 && !REDUCED_MOTION) {
      const power = this.shakePower * (this.shakeTime / this.shakeMax) * scale;
      ox = Math.round((Math.random() * 2 - 1) * power);
      oy = Math.round((Math.random() * 2 - 1) * power);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ox || oy) {
      ctx.fillStyle = '#0d130f';
      ctx.fillRect(0, 0, width, width);
    }
    ctx.drawImage(this.layer, ox, oy);
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    for (const mark of this.scorches) this.drawScorch(ctx, mark);
    for (const enemy of this.enemies) if (enemy.alive) this.drawTank(ctx, enemy);
    for (const player of this.players) if (player.alive) this.drawTank(ctx, player);
    if (this.players.length > 1) {
      // A name tag over grass would give away a hidden tank.
      for (const player of this.players) if (player.alive && !this.inGrass(player)) this.drawLabel(ctx, player);
    }
    // Heavier shells are bigger: 4px plain, 5px double, 6px gold triple.
    for (const bullet of this.bullets) {
      const size = 3 + (bullet.damage ?? 1);
      ctx.fillStyle = bullet.damage >= MAX_POWER ? GOLD : bullet.damage > 1 ? '#f5a35c' : bullet.player ? '#f3edbd' : '#ed8d5d';
      ctx.fillRect(bullet.x - size / 2, bullet.y - size / 2, size, size);
    }
    // Grass covers tanks, names and shells; bonuses and the fortress stay on top.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.grassLayer, ox, oy);
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    for (const bonus of this.bonuses) this.drawBonus(ctx, bonus);
    if (this.boss) this.drawBoss(ctx, this.boss);
    this.drawEffects(ctx);
    this.needsDraw = false;
  }

  // --- Effects -------------------------------------------------------------
  // Purely visual. The host logs each blast in its snapshots and every peer animates it locally.

  clearEffects() {
    this.effects = [];
    this.pending = [];
    this.scorches = [];
    this.fxLog = [];
    this.shakeTime = 0;
    this.shakeMax = 1;
    this.shakePower = 0;
  }

  explode(kind, x, y) {
    if (this.role === 'client') return;
    this.fxLog.push({ id: this.nextFx++, kind, x: round(x), y: round(y), age: 0 });
    this.spawnEffect(kind, x, y);
  }

  addShake(time, power) {
    const current = this.shakeTime > 0 ? this.shakePower * this.shakeTime / this.shakeMax : 0;
    if (power < current) return;
    this.shakeTime = this.shakeMax = time;
    this.shakePower = power;
  }

  // kind: 'spark' (shell stopped), 'brick' (wall chipped), 'tank', 'big', 'base' or 'boss' (a chain of blasts).
  spawnEffect(kind, x, y) {
    const rand = (min, max) => min + Math.random() * (max - min);
    const add = (count, make) => {
      for (let i = 0; i < count; i++) this.effects.push({ vx: 0, vy: 0, drag: 0, grow: 0, delay: 0, ...make() });
    };
    const outward = (min, max) => {
      const angle = Math.random() * Math.PI * 2, speed = rand(min, max);
      return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
    };

    if (kind === 'spark' || kind === 'brick') {
      const brick = kind === 'brick';
      add(1, () => ({ type: 'flash', x, y, size: 2, grow: 22, life: 0.09, max: 0.09 }));
      add(brick ? 5 : 6, () => {
        const life = rand(0.2, 0.45);
        return {
          type: brick ? 'chip' : 'spark', x, y, ...outward(35, 95), drag: 5, life, max: life,
          size: brick ? rand(1, 2.2) : 1, color: brick ? (Math.random() < 0.5 ? '#a65f3c' : '#d18a5c') : '#ffe9a8',
        };
      });
      if (brick) add(1, () => ({ type: 'smoke', x, y, vy: -6, size: 2, grow: 7, life: 0.5, max: 0.5, color: '#6b5a4c' }));
      return;
    }

    if (kind === 'boss') {
      for (let i = 0; i < 7; i++) {
        this.pending.push({ kind: 'tank', x: x + rand(-20, 20), y: y + rand(-12, 12), delay: i * 0.17 });
      }
      this.pending.push({ kind: 'big', x, y, delay: 1.25 });
      this.addShake(1.5, 1.5);
      this.onBlast?.('boss');
      return;
    }

    // 'tank', 'big' and 'base': flash, shock ring, fireballs, sparks, debris and smoke.
    const s = kind === 'tank' ? 1 : 2;
    add(1, () => ({ type: 'flash', x, y, size: 5 * s, grow: 70 * s, life: 0.14, max: 0.14 }));
    add(1, () => ({ type: 'ring', x, y, size: 3 * s, grow: 75 * s, life: 0.35, max: 0.35 }));
    add(6 * s, () => {
      const life = rand(0.35, 0.65);
      return { type: 'fire', x: x + rand(-4, 4) * s, y: y + rand(-4, 4) * s, ...outward(5, 28 * s), drag: 3, size: rand(2.5, 4.5) * s, grow: 6, life, max: life };
    });
    add(10 * s, () => {
      const life = rand(0.3, 0.6);
      return { type: 'spark', x, y, ...outward(70, 150), drag: 4, size: 1, life, max: life, color: Math.random() < 0.5 ? '#ffe9a8' : '#ffb347' };
    });
    add(6 * s, () => {
      const life = rand(0.6, 1);
      const color = ['#2f3531', '#4f5755', '#5e3221', '#b8673f'][Math.floor(Math.random() * 4)];
      return { type: 'chip', x, y, ...outward(40, 105), drag: 3, size: rand(1.5, 2.5), life, max: life, color };
    });
    add(4 * s, () => {
      const life = rand(0.9, 1.5);
      return {
        type: 'smoke', x: x + rand(-4, 4) * s, y: y + rand(-3, 3) * s, vx: rand(-4, 4), vy: -rand(6, 14),
        size: rand(3, 5) * s, grow: 6, life, max: life, delay: rand(0.08, 0.3), color: '#3b403c',
      };
    });
    this.scorches.push({ x, y, r: 7 * s, life: 8, max: 8 });
    if (this.scorches.length > 24) this.scorches.shift();
    this.addShake(s === 1 ? 0.22 : 0.6, s === 1 ? 1.2 : 2.5);
    this.onBlast?.(kind);
  }

  updateEffects(dt) {
    if (this.pending.length) {
      for (const item of this.pending) item.delay -= dt;
      const ready = this.pending.filter(item => item.delay <= 0);
      this.pending = this.pending.filter(item => item.delay > 0);
      for (const item of ready) this.spawnEffect(item.kind, item.x, item.y);
    }
    for (const p of this.effects) {
      if (p.delay > 0) {
        p.delay -= dt;
        continue;
      }
      p.life -= dt;
      const keep = Math.max(0, 1 - p.drag * dt);
      p.vx *= keep;
      p.vy *= keep;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.grow * dt;
    }
    this.effects = this.effects.filter(p => p.life > 0);
    for (const mark of this.scorches) mark.life -= dt;
    this.scorches = this.scorches.filter(mark => mark.life > 0);
    this.shakeTime = Math.max(0, this.shakeTime - dt);
    for (const fx of this.fxLog) fx.age += dt;
    this.fxLog = this.fxLog.filter(fx => fx.age < 0.4);
  }

  get animating() {
    return this.effects.length > 0 || this.pending.length > 0 || this.shakeTime > 0;
  }

  drawEffects(ctx) {
    // Smoke first so fire and sparks burn through it.
    for (const pass of ['smoke', 'rest']) {
      for (const p of this.effects) {
        if (p.delay > 0 || (pass === 'smoke') !== (p.type === 'smoke')) continue;
        const t = Math.max(0, p.life / p.max);
        if (p.type === 'smoke') {
          ctx.globalAlpha = 0.45 * t;
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        } else if (p.type === 'flash') {
          ctx.globalAlpha = t;
          ctx.fillStyle = '#fffbe6';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        } else if (p.type === 'ring') {
          ctx.globalAlpha = t * 0.8;
          ctx.strokeStyle = '#ffd89a';
          ctx.lineWidth = 0.5 + t * 1.5;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.stroke();
        } else if (p.type === 'fire') {
          // Cools from white-hot through orange to a dark ember.
          ctx.globalAlpha = Math.min(1, t * 1.8);
          ctx.fillStyle = t > 0.75 ? '#fff3b0' : t > 0.5 ? '#ffc94a' : t > 0.3 ? '#f07a3a' : '#7a3a28';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.6 + t * 0.4), 0, Math.PI * 2); ctx.fill();
        } else if (p.type === 'spark') {
          ctx.globalAlpha = Math.min(1, t * 2);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.lineTo(p.x, p.y); ctx.stroke();
        } else {
          ctx.globalAlpha = Math.min(1, t * 2);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawScorch(ctx, mark) {
    const t = mark.life / mark.max;
    ctx.globalAlpha = Math.min(1, t * 2) * 0.5;
    ctx.fillStyle = '#0b0f0c';
    ctx.beginPath(); ctx.arc(mark.x, mark.y, mark.r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha *= 0.8;
    ctx.beginPath(); ctx.arc(mark.x, mark.y, mark.r * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Static background (grid, blocks, base) and the grass overlay.
  // Redrawn only when the map or canvas size changes.
  drawLayer(width) {
    const ctx = this.layerCtx;
    const grass = this.grassCtx;
    this.layerDirty = false;
    grass.setTransform(1, 0, 0, 1, 0, 0);
    grass.clearRect(0, 0, width, width);
    grass.setTransform(width / SIZE, 0, 0, width / SIZE, 0, 0);
    ctx.setTransform(width / SIZE, 0, 0, width / SIZE, 0, 0);
    ctx.fillStyle = '#172119';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = 'rgba(228,239,217,.035)';
    ctx.beginPath();
    for (let i = 0; i <= SIZE; i += TILE) {
      ctx.moveTo(i, 0); ctx.lineTo(i, SIZE);
      ctx.moveTo(0, i); ctx.lineTo(SIZE, i);
    }
    ctx.stroke();
    for (let i = 0; i < this.map.length; i++) {
      const type = this.map[i];
      if (!type) continue;
      const x = (i % GRID) * TILE, y = Math.floor(i / GRID) * TILE;
      if (type === WATER) this.drawWater(ctx, x, y);
      else if (type === GRASS) this.drawGrass(grass, x, y);
      else if (type === STEEL) this.drawSteel(ctx, x, y);
      else this.drawBrick(ctx, x, y, this.bricks[i]);
    }
    if (this.match !== 'pvp') this.drawBase(ctx);
  }

  drawBrick(ctx, x, y, mask) {
    for (let q = 0; q < 4; q++) {
      if (!(mask & (1 << q))) continue;
      const qx = x + (q & 1) * 8, qy = y + (q >> 1) * 8;
      ctx.fillStyle = '#a65f3c';
      ctx.fillRect(qx, qy, 8, 8);
      ctx.fillStyle = '#d18a5c';
      ctx.fillRect(qx, qy, 8, 1); ctx.fillRect(qx, qy + 4, 8, 1);
      ctx.fillStyle = '#4f2a1c';
      ctx.fillRect(qx, qy + 3, 8, 1); ctx.fillRect(qx, qy + 7, 8, 1);
      ctx.fillRect(qx + 5, qy, 1, 3); ctx.fillRect(qx + 1, qy + 4, 1, 3);
    }
  }

  drawSteel(ctx, x, y) {
    for (let q = 0; q < 4; q++) {
      const qx = x + (q & 1) * 8, qy = y + (q >> 1) * 8;
      ctx.fillStyle = '#3a4441';
      ctx.fillRect(qx, qy, 8, 8);
      ctx.fillStyle = '#c3cec4';
      ctx.fillRect(qx, qy, 7, 7);
      ctx.fillStyle = '#7d8b85';
      ctx.fillRect(qx + 1, qy + 1, 6, 6);
      ctx.fillStyle = '#c3cec4';
      ctx.fillRect(qx + 3, qy + 3, 2, 2);
    }
  }

  drawGrass(ctx, x, y) {
    ctx.fillStyle = '#24502a';
    ctx.fillRect(x, y, TILE, TILE);
    for (const [tx, ty] of [[0, 1], [5, 0], [10, 2], [2, 6], [8, 6], [13, 8], [0, 11], [5, 11], [10, 13]]) {
      ctx.fillStyle = '#3f7d3a';
      ctx.fillRect(x + tx, y + ty, 3, 3);
      ctx.fillStyle = '#7dbd55';
      ctx.fillRect(x + tx + 1, y + ty, 1, 2);
    }
  }

  drawWater(ctx, x, y) {
    ctx.fillStyle = '#24505e';
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = '#4f8fa3';
    ctx.fillRect(x + 2, y + 4, 5, 1);
    ctx.fillRect(x + 9, y + 9, 5, 1);
    ctx.fillRect(x + 4, y + 13, 4, 1);
  }

  drawBase(ctx) {
    if (this.baseDestroyed) {
      // Rubble with a dying ember in the middle.
      ctx.fillStyle = '#2a2f2b';
      ctx.fillRect(BASE.x + 2, BASE.y + 6, 12, 8);
      ctx.fillStyle = '#4b524d';
      ctx.fillRect(BASE.x + 3, BASE.y + 9, 4, 3);
      ctx.fillRect(BASE.x + 9, BASE.y + 8, 3, 4);
      ctx.fillStyle = '#e07850';
      ctx.fillRect(BASE.x + 7, BASE.y + 11, 2, 2);
      return;
    }
    if (this.baseArmor > 0) {
      // Steel plating around the core.
      ctx.fillStyle = '#9aa7a3';
      ctx.fillRect(BASE.x + 1, BASE.y + 1, 14, 14);
      ctx.fillStyle = '#5b6663';
      ctx.fillRect(BASE.x + 2, BASE.y + 2, 12, 12);
    }
    ctx.fillStyle = '#c8f169';
    ctx.fillRect(BASE.x + 3, BASE.y + 3, 10, 10);
    ctx.fillStyle = '#273321';
    ctx.fillRect(BASE.x + 6, BASE.y + 6, 4, 4);
    if (this.fortLevel >= BASE_GUN_LEVEL) {
      ctx.fillStyle = GOLD;
      ctx.fillRect(BASE.x + 7, BASE.y + 7, 2, 2);
    }
  }

  // Tanks are drawn facing up around their centre; each type has its own silhouette.
  drawTank(ctx, tank) {
    const kind = tank.player ? 'player' : tank.type;
    const c = tank.flash > 0 ? TANK_STYLES.hit : tank.player ? PLAYER_STYLES[tank.slot ?? 0] : TANK_STYLES[kind];
    const tread = Math.floor(tank.tread) % 3;
    ctx.save();
    ctx.translate(tank.x + 8, tank.y + 8);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fillRect(-7, -6, 16, 15);
    ctx.rotate(DIRECTIONS[tank.direction].angle);
    if (tank.boat) {
      // Pontoon hull: a pointed bow under the tracks.
      ctx.fillStyle = '#4f8fa3';
      ctx.beginPath();
      ctx.moveTo(0, -11); ctx.lineTo(9, -6); ctx.lineTo(9, 9); ctx.lineTo(-9, 9); ctx.lineTo(-9, -6);
      ctx.closePath(); ctx.fill();
    }
    if (kind === 'fast') this.drawFastTank(ctx, c, tread);
    else if (kind === 'armor') this.drawArmorTank(ctx, c, tread, tank.hp);
    else if (kind === 'basic') this.drawBasicTank(ctx, c, tread);
    else {
      if (tank.speedLevel) this.drawExhaust(ctx, tank.speedLevel);
      this.drawPlayerTank(ctx, c, tread, tank.power);
    }
    if (tank.shield > 0) {
      ctx.strokeStyle = `rgba(193,238,255,${0.55 + Math.sin(this.frame * 14) * 0.3})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // Name above the tank, or below it on the top row; kept inside the field.
  drawLabel(ctx, player) {
    const name = player.name.slice(0, 10);
    ctx.font = '600 5px Unbounded, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = player.y < 8 ? 'top' : 'bottom';
    const half = ctx.measureText(name).width / 2 + 1;
    const x = Math.min(SIZE - half, Math.max(half, player.x + 8));
    const y = player.y < 8 ? player.y + TILE + 2 : player.y - 2;
    ctx.fillStyle = 'rgba(11,16,13,.75)';
    ctx.fillText(name, x + 0.5, y + 0.5);
    ctx.fillStyle = PLAYER_STYLES[player.slot].light;
    ctx.fillText(name, x, y);
  }

  // A pair of mirrored tracks; the links scroll with distance travelled.
  drawTracks(ctx, c, x, w, top, h, tread) {
    for (const side of [x, -x - w]) {
      ctx.fillStyle = c.track;
      ctx.fillRect(side, top, w, h);
      ctx.fillStyle = c.dark;
      for (let y = top + tread; y < top + h; y += 3) ctx.fillRect(side, y, w, 1);
    }
  }

  // Medium tank that grows with power: 1 adds a long gun and gold trim,
  // 2 adds side skirts and a bigger turret, 3 adds twin guns and an antenna.
  drawPlayerTank(ctx, c, tread, power) {
    const gold = c === TANK_STYLES.hit ? c.light : GOLD;
    this.drawTracks(ctx, c, -8, 4, -7, 15, tread);
    if (power >= 2) {
      for (const y of [-5, 1]) {
        ctx.fillStyle = c.hull;
        ctx.fillRect(-8, y, 4, 4); ctx.fillRect(4, y, 4, 4);
        ctx.fillStyle = c.light;
        ctx.fillRect(-8, y, 4, 1); ctx.fillRect(4, y, 4, 1);
      }
    }
    ctx.fillStyle = c.dark;
    ctx.fillRect(-5, -7, 10, 15);
    ctx.fillStyle = c.hull;
    ctx.fillRect(-4, -6, 8, 13);
    ctx.fillStyle = c.light;
    ctx.fillRect(-4, -6, 8, 2);
    ctx.fillStyle = power >= 1 ? gold : c.dark;
    ctx.fillRect(-3, 5, 2, 1); ctx.fillRect(1, 5, 2, 1);
    if (power >= 3) {
      ctx.fillStyle = c.dark;
      ctx.fillRect(3, 2, 1, 6);
      ctx.fillStyle = gold;
      ctx.fillRect(3, 1, 1, 1);
    }
    const r = power >= 2 ? 5 : 4.5;
    ctx.fillStyle = power >= 3 ? gold : c.dark;
    ctx.beginPath(); ctx.arc(0, 1, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.hull;
    ctx.beginPath(); ctx.arc(0, 1, r - 1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.light;
    ctx.beginPath(); ctx.arc(-1, 0, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.dark;
    ctx.fillRect(1, 2, 2, 2);
    if (power >= 2) {
      ctx.fillStyle = c.light;
      ctx.fillRect(1.5, 2.5, 1, 1);
    }
    const tip = power >= 1 ? -13 : -11;
    const barrels = power >= 3 ? [-2.5, 0.5] : [-1.5];
    for (const bx of barrels) {
      ctx.fillStyle = c.dark;
      ctx.fillRect(bx, tip, power >= 3 ? 2 : 3, -tip - 2);
      ctx.fillStyle = c.light;
      ctx.fillRect(bx + (power >= 3 ? 0.5 : 1), tip + 1, 1, -tip - 4);
    }
    ctx.fillStyle = power >= 1 ? gold : c.dark;
    ctx.fillRect(power >= 3 ? -3.5 : -2, tip - 1, power >= 3 ? 7 : 4, 2);
  }

  // Light tank: boxy hull, square turret, short stubby gun.
  drawBasicTank(ctx, c, tread) {
    this.drawTracks(ctx, c, -8, 4, -6, 14, tread);
    ctx.fillStyle = c.dark;
    ctx.fillRect(-5, -6, 10, 14);
    ctx.fillStyle = c.hull;
    ctx.fillRect(-4, -5, 8, 12);
    ctx.fillStyle = c.light;
    ctx.fillRect(-4, -5, 8, 1);
    ctx.fillStyle = c.dark;
    ctx.fillRect(-4, 5, 8, 1);
    ctx.fillRect(-4, -3, 8, 8);
    ctx.fillStyle = c.light;
    ctx.fillRect(-3, -2, 6, 6);
    ctx.fillStyle = c.hull;
    ctx.fillRect(-2, -1, 4, 4);
    ctx.fillStyle = c.dark;
    ctx.fillRect(-1, 0, 2, 2);
    ctx.fillRect(-1.5, -9, 3, 6);
    ctx.fillStyle = c.light;
    ctx.fillRect(-0.5, -8, 1, 4);
  }

  // Scout: narrow tracks, wedge hull, small rear turret and a long thin gun.
  drawFastTank(ctx, c, tread) {
    this.drawTracks(ctx, c, -7, 3, -6, 14, tread);
    ctx.fillStyle = c.dark;
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(5, -4); ctx.lineTo(5, 8); ctx.lineTo(-5, 8); ctx.lineTo(-5, -4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = c.hull;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(4, -3); ctx.lineTo(4, 7); ctx.lineTo(-4, 7); ctx.lineTo(-4, -3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = c.light;
    ctx.fillRect(-0.5, -6, 1, 4);
    ctx.fillRect(-3, 6, 2, 1); ctx.fillRect(1, 6, 2, 1);
    ctx.fillStyle = c.dark;
    ctx.beginPath(); ctx.arc(0, 2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.light;
    ctx.beginPath(); ctx.arc(0, 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.dark;
    ctx.fillRect(-0.5, -12, 1, 12);
  }

  // Heavy tank: wide tracks under skirt plates, octagonal turret, thick gun, armour pips.
  drawArmorTank(ctx, c, tread, hp) {
    this.drawTracks(ctx, c, -8, 5, -8, 16, tread);
    for (const y of [-5, -1, 3]) {
      ctx.fillStyle = c.hull;
      ctx.fillRect(-8, y, 5, 3); ctx.fillRect(3, y, 5, 3);
      ctx.fillStyle = c.light;
      ctx.fillRect(-8, y, 5, 1); ctx.fillRect(3, y, 5, 1);
    }
    ctx.fillStyle = c.dark;
    ctx.fillRect(-4, -8, 8, 16);
    ctx.fillStyle = c.hull;
    ctx.fillRect(-3, -7, 6, 14);
    ctx.fillStyle = c.dark;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + i * Math.PI / 4;
      ctx.lineTo(Math.cos(a) * 5.5, 1 + Math.sin(a) * 5.5);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = c.light;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + i * Math.PI / 4;
      ctx.lineTo(Math.cos(a) * 4.2, 1 + Math.sin(a) * 4.2);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = c.dark;
    for (let i = 0; i < 3; i++) {
      if (i >= hp) ctx.fillStyle = c.track;
      ctx.fillRect(-2.5 + i * 2, 3, 1, 1);
    }
    ctx.fillStyle = c.dark;
    ctx.fillRect(-2, -11, 4, 8);
    ctx.fillStyle = c.hull;
    ctx.fillRect(-1, -10, 2, 6);
    ctx.fillStyle = c.dark;
    ctx.fillRect(-3, -12, 6, 2);
  }

  // Flickering jet flames behind a sped-up tank: one pair per speed level.
  drawExhaust(ctx, level) {
    const flicker = Math.floor(this.frame * 20) % 2;
    for (const x of level >= 2 ? [-7, -3, 2, 6] : [-3, 2]) {
      ctx.fillStyle = '#f5a35c';
      ctx.fillRect(x, 8, 1.5, 2 + flicker);
      ctx.fillStyle = '#fff1b8';
      ctx.fillRect(x, 8, 1.5, 1);
    }
  }

  // Heavy siege tank seen from above, nose down: wide tracks, armoured hull,
  // two turrets on the front and a triple gun that wakes up once they are gone.
  drawBoss(ctx, boss) {
    if (boss.dying && Math.floor(this.frame * 18) % 2) return;
    const armed = boss.guns.some(gun => gun.hp > 0);
    const c = boss.flash ? TANK_STYLES.hit : { light: '#a3ad9f', hull: '#68736b', dark: '#343c37', track: '#1d2420' };
    const tread = Math.floor(boss.x) % 3;
    ctx.save();
    ctx.translate(boss.x, boss.y);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fillRect(2, 3, BOSS_W, BOSS_H);
    for (const x of [0, BOSS_W - 6]) {
      ctx.fillStyle = c.track;
      ctx.fillRect(x, 0, 6, BOSS_H);
      ctx.fillStyle = c.dark;
      for (let y = tread; y < BOSS_H; y += 3) ctx.fillRect(x, y, 6, 1);
    }
    ctx.fillStyle = c.dark;
    ctx.fillRect(5, 1, BOSS_W - 10, BOSS_H - 2);
    ctx.fillStyle = c.hull;
    ctx.fillRect(6, 2, BOSS_W - 12, BOSS_H - 4);
    ctx.fillStyle = c.light;
    ctx.fillRect(6, 2, BOSS_W - 12, 1);
    // Rivets on the rear plate and a stripe on the nose that lights up once the hull is exposed.
    ctx.fillStyle = c.dark;
    for (let x = 9; x < BOSS_W - 8; x += 4) ctx.fillRect(x, 4, 1, 1);
    ctx.fillStyle = armed ? '#8a5a3c' : '#e07850';
    ctx.fillRect(7, BOSS_H - 4, BOSS_W - 14, 1);
    // Core turret with three barrels; they run out once the side guns are gone.
    ctx.save();
    ctx.translate(BOSS_CORE, 16);
    ctx.fillStyle = c.dark;
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = armed ? c.hull : '#e07850';
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.dark;
    for (const bx of [-3, -0.75, 1.5]) ctx.fillRect(bx, 2, 1.5, armed ? 5 : 8);
    ctx.restore();
    for (const gun of boss.guns) this.drawBossGun(ctx, gun, c);
    ctx.restore();
  }

  drawBossGun(ctx, gun, hull) {
    ctx.save();
    ctx.translate(gun.dx, 13);
    if (gun.hp <= 0) {
      // Wreck: a scorched ring and a broken stub.
      ctx.fillStyle = '#2a2420';
      ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5e3221';
      ctx.fillRect(-1, -1, 3, 2); ctx.fillRect(1, 1, 2, 2);
      ctx.restore();
      return;
    }
    const c = gun.flash ? TANK_STYLES.hit : TANK_STYLES.basic;
    ctx.rotate(gun.angle - Math.PI / 2);
    ctx.fillStyle = c.dark;
    ctx.fillRect(-1.5, 2, 3, 9);
    ctx.fillStyle = c.light;
    ctx.fillRect(-0.5, 3, 1, 7);
    ctx.fillStyle = c.dark;
    ctx.fillRect(-2, 10, 4, 2);
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.hull;
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.light;
    ctx.beginPath(); ctx.arc(-1, -1, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Armour pips under the turret.
    const pips = Math.min(gun.maxHp, 6), lit = Math.ceil(gun.hp / gun.maxHp * pips);
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = i < lit ? '#e07850' : hull.track;
      ctx.fillRect(gun.dx - pips + i * 2, 19, 1, 1);
    }
  }

  drawBonus(ctx, bonus) {
    if (bonus.kind === 'speed') {
      // Lightning bolt on an orange plate.
      ctx.fillStyle = '#f5a35c';
      ctx.fillRect(bonus.x + 3, bonus.y + 3, 10, 10);
      ctx.fillStyle = '#172119';
      ctx.beginPath();
      ctx.moveTo(bonus.x + 9, bonus.y + 4); ctx.lineTo(bonus.x + 5, bonus.y + 9); ctx.lineTo(bonus.x + 8, bonus.y + 9);
      ctx.lineTo(bonus.x + 7, bonus.y + 12); ctx.lineTo(bonus.x + 11, bonus.y + 7); ctx.lineTo(bonus.x + 8, bonus.y + 7);
      ctx.closePath(); ctx.fill();
      return;
    }
    if (bonus.kind === 'fort') {
      // Steel battlement around a green core.
      ctx.fillStyle = '#c3cec4';
      ctx.fillRect(bonus.x + 3, bonus.y + 6, 10, 7);
      for (const mx of [3, 7, 11]) ctx.fillRect(bonus.x + mx, bonus.y + 4, 2, 2);
      ctx.fillStyle = '#7d8b85';
      ctx.fillRect(bonus.x + 4, bonus.y + 7, 8, 5);
      ctx.fillStyle = '#c8f169';
      ctx.fillRect(bonus.x + 7, bonus.y + 9, 2, 3);
      return;
    }
    if (bonus.kind === 'star') {
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, len = i % 2 ? 2.6 : 6;
        ctx.lineTo(bonus.x + 8 + Math.cos(a) * len, bonus.y + 8.5 + Math.sin(a) * len);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#172119';
      ctx.fillRect(bonus.x + 7, bonus.y + 7, 2, 2);
      return;
    }
    if (bonus.kind === 'boat') {
      ctx.fillStyle = '#4f8fa3';
      ctx.fillRect(bonus.x + 3, bonus.y + 3, 10, 10);
      ctx.fillStyle = '#172119';
      ctx.fillRect(bonus.x + 7, bonus.y + 4, 2, 5);
      ctx.fillRect(bonus.x + 4, bonus.y + 9, 8, 2);
      ctx.fillRect(bonus.x + 5, bonus.y + 11, 6, 1);
      return;
    }
    ctx.fillStyle = bonus.kind === 'life' ? '#d5f47e' : '#8bd6e8';
    ctx.fillRect(bonus.x + 4, bonus.y + 4, 8, 8);
    ctx.fillStyle = '#172119';
    ctx.fillRect(bonus.x + 7, bonus.y + 5, 2, 6);
    ctx.fillRect(bonus.x + 5, bonus.y + 7, 6, 2);
  }

  loop(now) {
    if (this.destroyed) return;
    const dt = Math.min(0.033, Math.max(0, (now - (this.lastTime || now)) / 1000));
    this.lastTime = now;
    this.update(dt);
    // Blasts keep playing behind the result screen, but freeze with the pause.
    if (this.mode !== 'paused') this.updateEffects(dt);
    if (this.mode === 'playing' || this.needsDraw || this.animating) this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
  }
}

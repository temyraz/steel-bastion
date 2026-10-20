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
const COOP_SPAWNS = [[64, 176], [128, 176], [64, 160], [128, 160]];
const PVP_SPAWNS = [[0, 0], [192, 192], [192, 0], [0, 192]];

// Compact indexes used in network snapshots.
const DIR_NAMES = ['up', 'right', 'down', 'left'];
const ENEMY_TYPES = ['basic', 'fast', 'armor'];
const BONUS_KINDS = ['shield', 'life', 'star', 'boat'];

const overlapsRect = (x, y, w, h, b) =>
  x < b.x + b.w && x + w > b.x &&
  y < b.y + b.h && y + h > b.y;
const round = value => Math.round(value * 10) / 10;

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
    for (const player of this.players) {
      // Players knocked out in the previous sector rejoin with one tank.
      if (player.lives <= 0) player.lives = 1;
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
    for (const [x, y] of [[5, 11], [7, 11], [5, 12], [7, 12], [6, 11]]) this.map[y * GRID + x] = WALL;
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
      alive: true, shield: player ? 1.8 : 0, boat: false, power: 0,
    };
  }

  makePlayer({ id, name = '' }, slot) {
    return Object.assign(this.makeTank(0, 0, 'up', true), {
      id, name, slot, lives: 3, kills: 0, respawn: 0,
      input: { direction: null, fire: false },
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
      for (let col = x; col < x + w; col++) this.map[row * GRID + col] = 0;
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
          const hp = 8 + this.level * 2 + (this.players.length - 1) * 4;
          this.boss = { x: 80, y: 22, w: 48, h: 32, hp, maxHp: hp, direction: 1, cooldown: 1.2 };
        }
      }
      if (this.boss && this.boss.hp <= 0) {
        this.boss = null;
        this.score += 2000;
        this.mode = 'won';
        this.notify();
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
        Object.assign(player, { power: 0, boat: false, shield: 2 });
        this.placePlayer(player);
      }
      return;
    }
    const input = player.id === this.localId ? this.input : player.input;
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.shield = Math.max(0, player.shield - dt);
    if (input.direction) this.move(player, input.direction, player.speed * dt);
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

  updateBoss(dt) {
    if (!this.boss) return;
    const boss = this.boss;
    boss.x += boss.direction * (18 + this.level * 2) * dt;
    if (boss.x < 2) {
      boss.x = 2;
      boss.direction = 1;
    } else if (boss.x + boss.w > SIZE - 2) {
      boss.x = SIZE - 2 - boss.w;
      boss.direction = -1;
    }
    boss.cooldown -= dt;
    if (boss.cooldown <= 0) {
      const x = boss.x + boss.w / 2, y = boss.y + boss.h;
      this.bullets.push({ x, y, vx: 0, vy: 82, owner: boss, player: false, alive: true });
      boss.cooldown = Math.max(0.6, 1.7 - this.level * 0.08);
    }
  }

  updateBullets(dt) {
    for (const bullet of this.bullets) {
      if (this.mode !== 'playing') break;
      if (!bullet.alive) continue;
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      if (bullet.x < 0 || bullet.y < 0 || bullet.x >= SIZE || bullet.y >= SIZE) {
        bullet.alive = false;
        continue;
      }
      const col = Math.floor(bullet.x / TILE), row = Math.floor(bullet.y / TILE);
      const cell = row * GRID + col;
      // Shells fly over water and through grass.
      const tile = this.map[cell];
      if (tile === WALL) {
        const q = (Math.floor(bullet.y / 8) & 1) * 2 + (Math.floor(bullet.x / 8) & 1);
        if (this.bricks[cell] & (1 << q)) {
          // A plain hit knocks out the half of the brick facing the shell; heavier shells take it all.
          const half = bullet.vx ? (q & 1 ? 0b1010 : 0b0101) : (q & 2 ? 0b1100 : 0b0011);
          this.bricks[cell] &= bullet.damage > 1 ? 0 : ~half;
          if (!this.bricks[cell]) this.map[cell] = 0;
          this.touchMap();
          bullet.alive = false;
          continue;
        }
      } else if (tile === STEEL) {
        if (bullet.steel) {
          this.map[cell] = 0;
          this.touchMap();
        }
        bullet.alive = false;
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
          this.mode = 'over';
          this.notify();
          continue;
        }
      } else {
        // Teammates soak up friendly shells; in PvP every other tank is fair game.
        if (target) {
          bullet.alive = false;
          if (this.match === 'pvp') this.hitPlayer(target, bullet.owner);
          continue;
        }
        const enemy = this.enemies.find(item => item.alive && overlapsRect(hx, hy, 4, 4, item));
        if (enemy) {
          bullet.alive = false;
          enemy.hp -= bullet.damage;
          enemy.flash = 0.12;
          if (enemy.hp <= 0) {
            enemy.alive = false;
            bullet.owner.kills++;
            this.score += enemy.type === 'armor' ? 400 : enemy.type === 'fast' ? 200 : 100;
          }
          continue;
        }
        if (this.boss && overlapsRect(hx, hy, 4, 4, this.boss)) {
          bullet.alive = false;
          this.boss.hp -= bullet.damage;
        }
      }
    }
    this.bullets = this.bullets.filter(bullet => bullet.alive);
  }

  hitPlayer(player, shooter = null) {
    if (player.shield > 0) return;
    player.alive = false;
    player.lives--;
    player.respawn = 1.2;
    if (shooter) shooter.kills++;
    const standing = this.players.filter(p => p.lives > 0);
    if (this.match === 'pvp') {
      if (this.players.length > 1 && standing.length <= 1) {
        this.winner = standing[0]?.id ?? null;
        this.mode = 'won';
      }
    } else if (!standing.length) {
      this.mode = 'over';
    }
    this.notify();
  }

  // Upgrades turn up every few seconds on a random open tile (grass counts, so some are hidden).
  spawnBonus() {
    if (this.bonuses.length >= 3) return;
    const free = [];
    for (let i = 0; i < this.map.length; i++) {
      const x = (i % GRID) * TILE, y = Math.floor(i / GRID) * TILE;
      if (this.map[i] && this.map[i] !== GRASS) continue;
      if (this.match !== 'pvp' && overlapsRect(x, y, TILE, TILE, BASE)) continue;
      if (this.bonuses.some(bonus => bonus.x === x && bonus.y === y)) continue;
      free.push([x, y]);
    }
    if (!free.length) return;
    const [x, y] = free[Math.floor(Math.random() * free.length)];
    const kinds = ['star', 'star', 'shield', 'life'];
    if (this.players.some(player => !player.boat)) kinds.push('boat');
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
      boss: this.boss ? { hp: this.boss.hp, maxHp: this.boss.maxHp } : null,
      crew: this.players.map(({ id, name, slot, lives, kills, alive }) => ({ id, name, slot, lives, kills, alive })),
      winner: this.winner ?? null,
    });
  }

  // --- Network state -------------------------------------------------------

  snapshot() {
    return {
      m: this.mode, t: this.match, l: this.level, s: this.score, v: this.mapVersion,
      q: this.queue.length + this.enemies.length, w: this.winner ?? '',
      p: this.players.map(p => [
        p.id, p.name, p.slot, round(p.x), round(p.y), DIR_NAMES.indexOf(p.direction), p.alive ? 1 : 0,
        p.shield > 0 ? 1 : 0, p.boat ? 1 : 0, p.power, p.lives, p.kills, Math.floor(p.tread) % 3,
      ]),
      e: this.enemies.map(e => [
        e.id, round(e.x), round(e.y), DIR_NAMES.indexOf(e.direction), ENEMY_TYPES.indexOf(e.type),
        e.hp, e.flash > 0 ? 1 : 0, Math.floor(e.tread) % 3,
      ]),
      b: this.bullets.map(b => [round(b.x), round(b.y), b.vx, b.vy, b.player ? b.damage : 0]),
      o: this.bonuses.map(o => [o.x, o.y, BONUS_KINDS.indexOf(o.kind)]),
      B: this.boss ? [round(this.boss.x), round(this.boss.y), this.boss.hp, this.boss.maxHp] : 0,
    };
  }

  applySnapshot(snap) {
    if (this.role !== 'client' || !snap) return;
    const previousMode = this.mode;
    this.mode = snap.m;
    this.match = snap.t;
    this.level = snap.l;
    this.score = snap.s;
    this.enemiesLeft = snap.q;
    this.winner = snap.w || null;
    // Tanks glide toward their reported position in updateClient instead of jumping.
    const sync = (list, id) => list.find(item => item.id === id);
    this.players = (snap.p ?? []).map(([id, name, slot, x, y, dir, alive, shield, boat, power, lives, kills, tread]) => {
      const player = sync(this.players, id) ?? Object.assign(this.makePlayer({ id, name }, slot), { x, y });
      return Object.assign(player, {
        name, slot, tx: x, ty: y, direction: DIR_NAMES[dir], alive: Boolean(alive), shield, boat: Boolean(boat),
        power, lives, kills, tread,
      });
    });
    this.enemies = (snap.e ?? []).map(([id, x, y, dir, type, hp, flash, tread]) => {
      const enemy = sync(this.enemies, id) ?? Object.assign(this.makeTank(x, y, 'down', false, ENEMY_TYPES[type]), { id });
      return Object.assign(enemy, { tx: x, ty: y, direction: DIR_NAMES[dir], hp, flash, tread });
    });
    this.bullets = (snap.b ?? []).map(([x, y, vx, vy, damage]) => ({ x, y, vx, vy, player: damage > 0, damage: Math.max(1, damage) }));
    this.bonuses = (snap.o ?? []).map(([x, y, kind]) => ({ x, y, kind: BONUS_KINDS[kind] }));
    if (snap.B) {
      const [x, y, hp, maxHp] = snap.B;
      this.boss = Object.assign(this.boss ?? { x, y, w: 48, h: 32 }, { tx: x, ty: y, hp, maxHp });
    } else this.boss = null;
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(width / SIZE, 0, 0, width / SIZE, 0, 0);
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
    ctx.drawImage(this.grassLayer, 0, 0);
    ctx.setTransform(width / SIZE, 0, 0, width / SIZE, 0, 0);
    for (const bonus of this.bonuses) this.drawBonus(ctx, bonus);
    if (this.boss) this.drawBoss(ctx, this.boss);
    this.needsDraw = false;
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
    ctx.fillStyle = '#c8f169';
    ctx.fillRect(BASE.x + 3, BASE.y + 3, 10, 10);
    ctx.fillStyle = '#273321';
    ctx.fillRect(BASE.x + 6, BASE.y + 6, 4, 4);
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
    else this.drawPlayerTank(ctx, c, tread, tank.power);
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

  drawBoss(ctx, boss) {
    ctx.fillStyle = '#41494a';
    ctx.fillRect(boss.x, boss.y, boss.w, boss.h);
    ctx.fillStyle = '#77847c';
    ctx.fillRect(boss.x + 5, boss.y + 5, boss.w - 10, boss.h - 10);
    ctx.fillStyle = '#e07850';
    ctx.fillRect(boss.x + boss.w / 2 - 4, boss.y + boss.h - 4, 8, 12);
    ctx.fillStyle = '#222b25';
    ctx.fillRect(boss.x - 2, boss.y + 4, 5, boss.h - 8);
    ctx.fillRect(boss.x + boss.w - 3, boss.y + 4, 5, boss.h - 8);
  }

  drawBonus(ctx, bonus) {
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
    if (this.mode === 'playing' || this.needsDraw) this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
  }
}

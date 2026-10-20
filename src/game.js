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

const TANK_COLORS = {
  player: ['#d5f47e', '#536c38'],
  armor: ['#aa9be0', '#504276'],
  fast: ['#82cdb0', '#365f50'],
  basic: ['#d27c54', '#713f2c'],
};
const ENEMY_TURNS = {
  up: ['down', 'left', 'right'],
  right: ['down', 'left', 'up'],
  down: ['left', 'right', 'up'],
  left: ['down', 'right', 'up'],
};

const overlapsRect = (x, y, w, h, b) =>
  x < b.x + b.w && x + w > b.x &&
  y < b.y + b.h && y + h > b.y;

export class TankGame {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layerCtx = this.layer.getContext('2d');
    this.layerDirty = true;
    this.needsDraw = true;
    this.onChange = onChange;
    this.input = { direction: null, fire: false };
    this.mode = 'title';
    this.score = 0;
    this.level = 1;
    this.lives = 3;
    this.frame = 0;
    this.lastTime = 0;
    this.lastUi = 0;
    this.destroyed = false;
    this.resizeObserver = new ResizeObserver(entries => this.resize(entries[0]));
    this.resizeObserver.observe(canvas);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.startLevel();
    this.mode = 'title';
    this.notify();
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

  start() {
    this.score = 0;
    this.level = 1;
    this.lives = 3;
    this.mode = 'playing';
    this.startLevel();
  }

  startLevel() {
    this.map = new Uint8Array(GRID * GRID);
    for (let y = 1; y < 10; y++) {
      for (let x = 0; x < GRID; x++) {
        if (Math.random() < 0.2) this.map[y * GRID + x] = Math.random() < 0.12 ? STEEL : WALL;
      }
    }
    const ponds = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < ponds; i++) {
      const w = 2 + Math.floor(Math.random() * 2);
      const x = Math.floor(Math.random() * (GRID - w + 1)), y = 3 + Math.floor(Math.random() * 6);
      for (let row = y; row < y + 2; row++) {
        for (let col = x; col < x + w; col++) this.map[row * GRID + col] = WATER;
      }
    }
    this.clearTiles(0, 0, 2, 2);
    this.clearTiles(6, 0, 1, 2);
    this.clearTiles(11, 0, 2, 2);
    this.clearTiles(5, 11, 3, 2);
    this.map[11 * GRID + 5] = WALL;
    this.map[11 * GRID + 7] = WALL;
    this.map[12 * GRID + 5] = WALL;
    this.map[12 * GRID + 7] = WALL;
    this.map[11 * GRID + 6] = WALL;
    this.enemies = [];
    this.bullets = [];
    this.bonuses = [];
    this.player = this.makeTank(64, 176, 'down', true);
    this.queue = Array.from({ length: Math.min(8 + this.level * 2, 30) }, (_, i) => {
      const pick = Math.random();
      return {
        type: pick < 0.12 ? 'armor' : pick < 0.35 ? 'fast' : 'basic',
        x: [0, 96, 192][i % 3],
      };
    });
    this.boss = null;
    this.spawnTimer = 0.8;
    this.bossTimer = 0;
    this.layerDirty = true;
    this.needsDraw = true;
    this.notify();
  }

  makeTank(x, y, direction, player = false, type = 'basic') {
    return {
      x, y, w: TILE, h: TILE, direction, player, type,
      hp: type === 'armor' ? 3 : 1,
      speed: player ? 58 : type === 'fast' ? 43 : type === 'armor' ? 21 : 28,
      cooldown: 0, turnTimer: 0.5 + Math.random(),
      alive: true, shield: player ? 1.8 : 0, boat: false,
    };
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

  togglePause() {
    if (this.mode === 'playing') this.mode = 'paused';
    else if (this.mode === 'paused') this.mode = 'playing';
    this.notify();
  }

  continueAfterWin() {
    if (this.mode !== 'won') return;
    // Upgrades carry over to the next sector.
    const { boat, shield } = this.player;
    this.level++;
    this.mode = 'playing';
    this.startLevel();
    this.player.boat = boat;
    this.player.shield = Math.max(this.player.shield, shield);
  }

  spawnPlayer() {
    const spots = [[64, 176], [128, 176], [64, 160], [128, 160]];
    const probe = { x: -SIZE, y: -SIZE, w: TILE, h: TILE };
    const [x, y] = spots.find(([sx, sy]) => !this.isBlocked(probe, sx, sy)) ?? spots[0];
    return this.makeTank(x, y, 'down', true);
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
    }
    return true;
  }

  isBlocked(entity, x, y) {
    const { w, h } = entity;
    if (x < 0 || y < 0 || x + w > SIZE || y + h > SIZE) return true;
    if (overlapsRect(x, y, w, h, BASE)) return true;
    const left = Math.floor(x / TILE), right = Math.floor((x + w - 1) / TILE);
    const top = Math.floor(y / TILE), bottom = Math.floor((y + h - 1) / TILE);
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const tile = this.map[row * GRID + col];
        if (tile && !(tile === WATER && entity.boat)) return true;
      }
    }
    if (this.blocks(entity, x, y, this.player) || this.blocks(entity, x, y, this.boss)) return true;
    for (const other of this.enemies) {
      if (this.blocks(entity, x, y, other)) return true;
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
    if (!tank.alive || tank.cooldown > 0 || this.bullets.some(b => b.owner === tank)) return;
    const dir = DIRECTIONS[tank.direction];
    this.bullets.push({
      x: tank.x + 8 + dir.x * 9, y: tank.y + 8 + dir.y * 9,
      vx: dir.x * (tank.player ? 180 : 112), vy: dir.y * (tank.player ? 180 : 112),
      owner: tank, player: tank.player, alive: true,
    });
    tank.cooldown = tank.player ? 0.24 : 0.9 + Math.random() * 0.8;
  }

  update(dt) {
    if (this.mode !== 'playing') return;
    this.frame += dt;
    this.player.cooldown = Math.max(0, this.player.cooldown - dt);
    this.player.shield = Math.max(0, this.player.shield - dt);
    if (this.input.direction) this.move(this.player, this.input.direction, this.player.speed * dt);
    if (this.input.fire) this.fire(this.player);

    this.spawnTimer -= dt;
    if (this.queue.length && this.spawnTimer <= 0 && this.enemies.length < 4) {
      const next = this.queue.shift();
      const occupied = (this.player.alive && overlapsRect(next.x, 0, TILE, TILE, this.player)) ||
        this.enemies.some(e => e.alive && overlapsRect(next.x, 0, TILE, TILE, e));
      if (!occupied) {
        this.enemies.push(this.makeTank(next.x, 0, 'down', false, next.type));
      } else this.queue.push(next);
      this.spawnTimer = 1.2;
    }

    for (const enemy of this.enemies) this.updateEnemy(enemy, dt);
    this.enemies = this.enemies.filter(enemy => enemy.alive);
    this.updateBoss(dt);
    this.updateBullets(dt);
    if (this.mode !== 'playing') return;
    this.updateBonuses(dt);

    if (!this.queue.length && !this.enemies.length && !this.boss && this.bossTimer <= 0) {
      this.bossTimer = 1.3;
    }
    if (this.bossTimer > 0) {
      this.bossTimer -= dt;
      if (this.bossTimer <= 0 && !this.queue.length && !this.enemies.length && !this.boss) {
        // The fortress lands on rows 1-3; clear them so walls don't hide it or swallow its shots.
        this.clearTiles(0, 1, GRID, 3);
        this.layerDirty = true;
        this.boss = { x: 80, y: 22, w: 48, h: 32, hp: 8 + this.level * 2, maxHp: 8 + this.level * 2, direction: 1, cooldown: 1.2 };
      }
    }
    if (this.boss && this.boss.hp <= 0) {
      this.boss = null;
      this.score += 2000;
      this.mode = 'won';
      this.notify();
    }

    if (this.frame - this.lastUi > 0.15) {
      this.lastUi = this.frame;
      this.notify();
    }
  }

  updateEnemy(enemy, dt) {
    if (!enemy.alive) return;
    enemy.cooldown = Math.max(0, enemy.cooldown - dt);
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
      // Shells fly over water.
      if (this.map[cell] && this.map[cell] !== WATER) {
        if (this.map[cell] === WALL) {
          this.map[cell] = 0;
          this.layerDirty = true;
        }
        bullet.alive = false;
        continue;
      }
      const hx = bullet.x - 2, hy = bullet.y - 2;
      if (!bullet.player) {
        if (this.player.alive && overlapsRect(hx, hy, 4, 4, this.player)) {
          bullet.alive = false;
          this.hitPlayer();
          continue;
        }
        if (overlapsRect(hx, hy, 4, 4, BASE)) {
          bullet.alive = false;
          this.mode = 'over';
          this.notify();
          continue;
        }
      } else {
        const enemy = this.enemies.find(item => item.alive && overlapsRect(hx, hy, 4, 4, item));
        if (enemy) {
          bullet.alive = false;
          enemy.hp--;
          if (enemy.hp <= 0) {
            enemy.alive = false;
            this.score += enemy.type === 'armor' ? 400 : enemy.type === 'fast' ? 200 : 100;
            if (Math.random() < 0.14) this.dropBonus(enemy.x, enemy.y);
          }
          continue;
        }
        if (this.boss && overlapsRect(hx, hy, 4, 4, this.boss)) {
          bullet.alive = false;
          this.boss.hp--;
        }
      }
    }
    this.bullets = this.bullets.filter(bullet => bullet.alive);
  }

  hitPlayer() {
    if (this.player.shield > 0) return;
    this.lives--;
    if (this.lives <= 0) {
      this.player.alive = false;
      this.mode = 'over';
      this.notify();
    } else {
      this.player.alive = false;
      this.player = this.spawnPlayer();
      this.player.shield = 2;
    }
  }

  dropBonus(x, y) {
    if (!this.map[Math.floor(y / TILE) * GRID + Math.floor(x / TILE)] && !overlapsRect(x, y, 16, 16, BASE)) {
      const pick = Math.random();
      const kind = pick < 0.3 && !this.player.boat ? 'boat' : pick < 0.65 ? 'shield' : 'life';
      this.bonuses.push({ x, y, kind, time: 8 });
    }
  }

  updateBonuses(dt) {
    for (const bonus of this.bonuses) {
      bonus.time -= dt;
      if (bonus.time <= 0) continue;
      if (overlapsRect(bonus.x, bonus.y, 16, 16, this.player)) {
        bonus.time = 0;
        if (bonus.kind === 'life') this.lives = Math.min(5, this.lives + 1);
        else if (bonus.kind === 'boat') this.player.boat = true;
        else this.player.shield = 8;
        this.score += 250;
      }
    }
    this.bonuses = this.bonuses.filter(bonus => bonus.time > 0);
  }

  notify() {
    this.needsDraw = true;
    this.onChange({
      mode: this.mode, score: this.score, level: this.level,
      lives: this.lives, enemies: this.queue.length + this.enemies.length,
      boss: this.boss ? { hp: this.boss.hp, maxHp: this.boss.maxHp } : null,
    });
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const width = this.canvas.width;
    if (this.layer.width !== width || this.layer.height !== width) {
      this.layer.width = this.layer.height = width;
      this.layerDirty = true;
    }
    if (this.layerDirty) this.drawLayer(width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(width / SIZE, 0, 0, width / SIZE, 0, 0);
    for (const bonus of this.bonuses) this.drawBonus(ctx, bonus);
    for (const enemy of this.enemies) if (enemy.alive) this.drawTank(ctx, enemy);
    if (this.player?.alive) this.drawTank(ctx, this.player);
    if (this.boss) this.drawBoss(ctx, this.boss);
    for (const bullet of this.bullets) {
      ctx.fillStyle = bullet.player ? '#f3edbd' : '#ed8d5d';
      ctx.fillRect(bullet.x - 2, bullet.y - 2, 4, 4);
    }
    this.needsDraw = false;
  }

  // Static background: grid, walls and base. Redrawn only when the map or canvas size changes.
  drawLayer(width) {
    const ctx = this.layerCtx;
    this.layerDirty = false;
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
      if (type === WATER) {
        this.drawWater(ctx, x, y);
        continue;
      }
      ctx.fillStyle = type === STEEL ? '#687772' : '#9b5939';
      ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
      ctx.fillStyle = type === STEEL ? '#a6b1a5' : '#cc8154';
      ctx.fillRect(x + 2, y + 2, TILE - 4, 2);
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.fillRect(x + 2, y + 8, TILE - 4, 2);
    }
    this.drawBase(ctx);
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

  drawTank(ctx, tank) {
    const colors = TANK_COLORS[tank.player ? 'player' : tank.type];
    ctx.save();
    ctx.translate(tank.x + 8, tank.y + 8);
    ctx.rotate(DIRECTIONS[tank.direction].angle);
    if (tank.boat) {
      // Pontoon hull: a pointed bow under the tracks.
      ctx.fillStyle = '#4f8fa3';
      ctx.beginPath();
      ctx.moveTo(0, -11); ctx.lineTo(9, -6); ctx.lineTo(9, 9); ctx.lineTo(-9, 9); ctx.lineTo(-9, -6);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = colors[1];
    ctx.fillRect(-8, -7, 4, 14); ctx.fillRect(4, -7, 4, 14);
    ctx.fillStyle = colors[0];
    ctx.fillRect(-5, -5, 10, 11);
    ctx.beginPath(); ctx.arc(0, 1, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(-1.5, -10, 3, 8);
    if (tank.shield > 0) {
      ctx.strokeStyle = 'rgba(193,238,255,.8)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
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

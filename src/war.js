import { TankGame } from './game.js?v=1021-1537';

// "Толпа на толпу" (match === 'war'): two teams, each with a base and a stream of AI tanks.
// Mixed into TankGame; game.js calls these methods only while match === 'war'.
// Players on even slots fight for the bottom base (team 0), odd slots for the top one (team 1).

// Must match game.js.
const SIZE = 208;
const TILE = 16;
const GRID = SIZE / TILE;
const WALL = 1;
const STEEL = 2;
const WATER = 3;
const GRASS = 4;

const BASE_HP = 12;
const UNIT_INTERVAL = 5;
const UNIT_CAP = 6;
const WAR_BASES = [{ x: 96, y: 192, w: TILE, h: TILE }, { x: 96, y: 0, w: TILE, h: TILE }];
// Bricks around each base, leaving the side facing the map edge open.
const WAR_FORTS = [
  [[5, 11], [6, 11], [7, 11], [5, 12], [7, 12]],
  [[5, 1], [6, 1], [7, 1], [5, 0], [7, 0]],
];
const PLAYER_SPAWNS = [[[64, 176], [128, 176]], [[128, 16], [64, 16]]];
const UNIT_SPAWNS = [[[0, 192], [192, 192]], [[192, 0], [0, 0]]];
const TEAM_COLORS = ['#c8f169', '#7fc3f0'];
// Unit palettes, a shade darker than the players of the same team.
const TEAM_STYLES = [
  { light: '#d3ec96', hull: '#7f9d46', dark: '#33441f', track: '#1d2614' },
  { light: '#b2daf5', hull: '#4d82b0', dark: '#213a52', track: '#141f2b' },
];

const overlapsRect = (x, y, w, h, b) =>
  x < b.x + b.w && x + w > b.x &&
  y < b.y + b.h && y + h > b.y;

Object.assign(TankGame.prototype, {
  teamOf(tank) {
    return tank.team ?? (tank.player ? tank.slot % 2 : 1);
  },

  teamPalette(team) {
    return TEAM_STYLES[team];
  },

  resetWar() {
    this.warBases = WAR_BASES.map(base => ({ ...base, hp: BASE_HP, maxHp: BASE_HP }));
    this.warTimer = 1.5;
    this.warSpawnIndex = [0, 0];
  },

  // Mirror-symmetric field with clear lanes around both bases and the four corner spawns.
  generateWarField() {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < GRID; x++) {
        const pick = Math.random();
        const tile = pick < 0.2 ? WALL : pick < 0.25 ? STEEL : pick < 0.31 ? GRASS : pick < 0.33 ? WATER : 0;
        this.map[y * GRID + x] = tile;
        this.map[(GRID - 1 - y) * GRID + (GRID - 1 - x)] = tile;
      }
    }
    for (const [x, y] of [[0, 0], [11, 0], [0, 11], [11, 11]]) this.clearTiles(x, y, 2, 2);
    this.clearTiles(3, 0, 7, 3);
    this.clearTiles(3, 10, 7, 3);
    for (const fort of WAR_FORTS) for (const [x, y] of fort) this.map[y * GRID + x] = WALL;
  },

  warSpawns(player) {
    const spots = PLAYER_SPAWNS[player.slot % 2];
    return player.slot >= 2 ? [spots[1], spots[0]] : spots;
  },

  warBaseBlocked(x, y, w, h) {
    return Boolean(this.warBases?.some(base => overlapsRect(x, y, w, h, base)));
  },

  // Tiles a bonus must not land on: bases and their forts.
  warReserved(cell) {
    const col = cell % GRID, row = Math.floor(cell / GRID);
    return WAR_FORTS.some(fort => fort.some(([x, y]) => x === col && y === row)) ||
      WAR_BASES.some(base => base.x / TILE === col && base.y / TILE === row);
  },

  // Bots and units never shoot or path through their own side's bricks.
  warOwnFort(bot, cell) {
    const col = cell % GRID, row = Math.floor(cell / GRID);
    return WAR_FORTS[this.teamOf(bot)].some(([x, y]) => x === col && y === row);
  },

  warBaseCell(team) {
    const base = WAR_BASES[team];
    return (base.y / TILE) * GRID + base.x / TILE;
  },

  updateWar(dt) {
    this.warTimer -= dt;
    if (this.warTimer <= 0) {
      this.warTimer = UNIT_INTERVAL;
      // Units act in spawn order, so neither side always gets to move first.
      const first = Math.random() < 0.5 ? 0 : 1;
      this.spawnUnit(first);
      this.spawnUnit(1 - first);
    }
    for (const unit of this.enemies) this.updateUnit(unit, dt);
    this.enemies = this.enemies.filter(unit => unit.alive);
  },

  spawnUnit(team) {
    if (this.enemies.filter(unit => unit.alive && unit.team === team).length >= UNIT_CAP) return;
    const spots = UNIT_SPAWNS[team];
    for (let i = 0; i < spots.length; i++) {
      const [x, y] = spots[(this.warSpawnIndex[team] + i) % spots.length];
      const probe = { x: -SIZE, y: -SIZE, w: TILE, h: TILE };
      if (this.isBlocked(probe, x, y)) continue;
      this.warSpawnIndex[team] = (this.warSpawnIndex[team] + i + 1) % spots.length;
      const pick = Math.random();
      const type = pick < 0.12 ? 'armor' : pick < 0.35 ? 'fast' : 'basic';
      const unit = Object.assign(this.makeTank(x, y, team ? 'down' : 'up', false, type), {
        id: this.nextId++, team, palette: TEAM_STYLES[team],
      });
      // Faster than wave enemies so the armies actually meet in the middle.
      unit.speed *= 1.3;
      this.enemies.push(unit);
      return;
    }
  },

  updateUnit(unit, dt) {
    if (!unit.alive) return;
    unit.cooldown = Math.max(0, unit.cooldown - dt);
    unit.flash = Math.max(0, unit.flash - dt);
    const input = this.updateBot(unit, dt);
    if (input.direction) this.move(unit, input.direction, unit.speed * dt);
    if (input.fire) this.fire(unit);
  },

  // Nearby enemies first, otherwise march on the enemy base; player bots grab close bonuses.
  warGoal(bot) {
    const team = this.teamOf(bot);
    const cellOf = item => this.cellAt(item.x + 8, item.y + 8);
    let best = null;
    for (const foe of [...this.players, ...this.enemies]) {
      if (!foe.alive || this.teamOf(foe) === team) continue;
      const d = Math.abs(foe.x - bot.x) + Math.abs(foe.y - bot.y);
      if (d < 64 && (!best || d < best.d)) best = { item: foe, d };
    }
    if (best) return cellOf(best.item);
    // A bot player hunts the enemy army first and only storms the base once the way is clear.
    if (bot.player) {
      for (const foe of [...this.players, ...this.enemies]) {
        if (!foe.alive || this.teamOf(foe) === team) continue;
        const d = Math.abs(foe.x - bot.x) + Math.abs(foe.y - bot.y);
        if (!best || d < best.d) best = { item: foe, d };
      }
      if (best) return cellOf(best.item);
    }
    if (bot.player) {
      for (const bonus of this.bonuses) {
        const d = Math.abs(bonus.x - bot.x) + Math.abs(bonus.y - bot.y);
        if (d < 64 && (!best || d < best.d)) best = { item: bonus, d };
      }
      if (best) return cellOf(best.item);
    }
    return this.warBaseCell(1 - team);
  },

  warTargets(bot) {
    const team = this.teamOf(bot);
    const foes = [...this.players, ...this.enemies]
      .filter(t => t.alive && this.teamOf(t) !== team && !(t.player && this.inGrass(t)));
    const base = this.warBases[1 - team];
    return base.hp > 0 ? [...foes, base] : foes;
  },

  // Resolves a shell against tanks and bases; returns true when the shell was used up.
  warHit(bullet, hx, hy) {
    const team = bullet.team;
    const tank = [...this.players, ...this.enemies]
      .find(t => t.alive && t !== bullet.owner && overlapsRect(hx, hy, 4, 4, t));
    const shooter = bullet.owner?.player ? bullet.owner : null;
    if (tank) {
      bullet.alive = false;
      if (this.teamOf(tank) === team) {
        this.explode('spark', bullet.x, bullet.y);
      } else if (tank.player) {
        this.hitPlayer(tank, shooter);
      } else {
        tank.hp -= bullet.damage;
        tank.flash = 0.12;
        if (tank.hp > 0) {
          this.explode('spark', bullet.x, bullet.y);
        } else {
          tank.alive = false;
          this.explode('tank', tank.x + 8, tank.y + 8);
          if (shooter) {
            shooter.kills++;
            shooter.roundKills++;
            this.score += 100;
          }
        }
      }
      return true;
    }
    const index = this.warBases.findIndex(base => base.hp > 0 && overlapsRect(hx, hy, 4, 4, base));
    if (index < 0) return false;
    bullet.alive = false;
    const base = this.warBases[index];
    if (index === team) {
      this.explode('spark', bullet.x, bullet.y);
      return true;
    }
    // One point per hit whatever the shell, so stars can't one-shot a base.
    base.hp--;
    this.touchMap();
    if (base.hp > 0) {
      this.explode('brick', bullet.x, bullet.y);
      return true;
    }
    this.explode('base', base.x + 8, base.y + 8);
    this.winner = `team${team}`;
    this.mode = 'won';
    this.notify();
    return true;
  },

  warStatus() {
    const me = this.localPlayer;
    const army = [0, 0];
    for (const unit of this.enemies) if (unit.alive && unit.team !== undefined) army[unit.team]++;
    return {
      team: me ? this.teamOf(me) : 0,
      bases: (this.warBases ?? []).map(base => base.hp),
      maxHp: BASE_HP,
      army,
      winnerTeam: this.winner?.startsWith('team') ? Number(this.winner.slice(4)) : null,
    };
  },

  applyWarSnapshot(snap) {
    const hp = snap.W ?? [BASE_HP, BASE_HP];
    if (!this.warBases) this.resetWar();
    if (this.warBases.some((base, i) => base.hp !== hp[i])) {
      this.warBases.forEach((base, i) => { base.hp = hp[i] ?? 0; });
      this.layerDirty = true;
    }
  },

  drawWarBases(ctx) {
    this.warBases.forEach((base, team) => {
      const { x, y } = base;
      if (base.hp <= 0) {
        ctx.fillStyle = '#2a2f2a';
        ctx.fillRect(x + 2, y + 6, 12, 8);
        ctx.fillStyle = '#4a4f47';
        ctx.fillRect(x + 3, y + 9, 4, 3);
        ctx.fillRect(x + 9, y + 8, 3, 4);
        return;
      }
      ctx.fillStyle = TEAM_COLORS[team];
      ctx.fillRect(x + 3, y + 3, 10, 10);
      ctx.fillStyle = '#273321';
      ctx.fillRect(x + 6, y + 6, 4, 4);
      // Health pips along the side facing the field.
      const py = team ? y + 14 : y;
      for (let i = 0; i < base.maxHp; i++) {
        ctx.fillStyle = i < base.hp ? TEAM_COLORS[team] : 'rgba(255,255,255,.15)';
        ctx.fillRect(x + 2 + i * 2.6, py, 2, 1.5);
      }
    });
  },

  // Team-coloured ground marks under every tank so both armies read at a glance.
  drawWarMarks(ctx) {
    for (const tank of [...this.players, ...this.enemies]) {
      if (!tank.alive) continue;
      ctx.fillStyle = TEAM_COLORS[this.teamOf(tank)];
      ctx.globalAlpha = 0.28;
      ctx.fillRect(tank.x - 1, tank.y - 1, TILE + 2, TILE + 2);
      ctx.globalAlpha = 1;
    }
  },
});

// [our team offset, their team offset] relative to the local player's team.
export const WAR_TEAMS = [0, 1];

export { TankGame };

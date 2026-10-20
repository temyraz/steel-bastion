import { firebaseConfig } from './firebase-config.js';
import { firebaseApp, loadFirebaseModule } from './firebase.js';

const snapshotInterval = 80;
const localNet = new URLSearchParams(location.search).get('net') === 'local';

export const MAX_CREW = 4;
export const netAvailable = Boolean(firebaseConfig) || localNet;

// Same small interface over Firebase Realtime Database and over BroadcastChannel
// (?net=local, for testing with several tabs of one browser).
async function firebaseStore() {
  const [app, db] = await Promise.all([firebaseApp(), loadFirebaseModule('firebase-database')]);
  const database = db.getDatabase(app);
  const at = path => db.ref(database, path);
  return {
    set: (path, value) => db.set(at(path), value),
    update: (path, value) => db.update(at(path), value),
    remove: path => db.remove(at(path)),
    get: async path => (await db.get(at(path))).val(),
    watch: (path, callback) => db.onValue(at(path), snap => callback(snap.val())),
    removeOnDisconnect: path => db.onDisconnect(at(path)).remove(),
  };
}

async function localStore() {
  const channel = new BroadcastChannel('steel-bastion-net');
  const listeners = new Set();
  const onLeave = new Set();
  let tree = {};
  const read = path => path.split('/').reduce((node, key) => node?.[key], tree) ?? null;
  const write = (path, value) => {
    const keys = path.split('/');
    const last = keys.pop();
    let node = tree;
    for (const key of keys) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    if (value === null || value === undefined) delete node[last];
    else node[last] = structuredClone(value);
  };
  const emit = () => {
    for (const listener of listeners) {
      const value = read(listener.path);
      const json = JSON.stringify(value);
      if (json === listener.last) continue;
      listener.last = json;
      listener.callback(value);
    }
  };
  const apply = op => {
    if (op.type === 'set') write(op.path, op.value);
    else if (op.type === 'update') for (const [key, value] of Object.entries(op.value)) write(`${op.path}/${key}`, value);
    else if (op.type === 'remove') write(op.path, null);
    emit();
  };
  const send = op => {
    apply(op);
    channel.postMessage(op);
  };
  channel.onmessage = ({ data }) => {
    if (data.type === 'hello') channel.postMessage({ type: 'tree', tree });
    else if (data.type === 'tree') {
      if (!Object.keys(tree).length) tree = data.tree;
      emit();
    } else apply(data);
  };
  window.addEventListener('pagehide', () => onLeave.forEach(path => send({ type: 'remove', path })));
  channel.postMessage({ type: 'hello' });
  // Give other tabs a moment to send the current state before anything is written.
  await new Promise(resolve => setTimeout(resolve, 200));
  return {
    set: async (path, value) => send({ type: 'set', path, value }),
    update: async (path, value) => send({ type: 'update', path, value }),
    remove: async path => send({ type: 'remove', path }),
    get: async path => structuredClone(read(path)),
    watch: (path, callback) => {
      const listener = { path, callback, last: undefined };
      listeners.add(listener);
      queueMicrotask(emit);
      return () => listeners.delete(listener);
    },
    removeOnDisconnect: async path => onLeave.add(path),
  };
}

let storePromise = null;
const getStore = () => (storePromise ??= localNet ? localStore() : firebaseStore());

export function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

// Room layout: rooms/{room}/players/{id} {name, joined}, meta {phase, match, host, round},
// inputs/{id} {d, f}, snap (host state ~12/s), map {v, s}.
// The earliest player still in the room is the commander: picks the mode and runs the battle.
export class Session {
  static async join({ room, me, game, onChange }) {
    const session = new Session(await getStore(), room, me, game, onChange);
    await session.connect();
    return session;
  }

  constructor(store, room, me, game, onChange) {
    this.store = store;
    this.room = room;
    this.me = me;
    this.game = game;
    this.onChange = onChange;
    this.base = `rooms/${room}`;
    this.players = {};
    this.meta = {};
    this.unsubscribe = [];
    this.sentInput = '';
    this.sentMap = -1;
    this.timer = null;
    this.lastSnap = null;
    this.lastMap = null;
    this.inputs = {};
    this.joined = 0;
    this.leaving = false;
  }

  async connect() {
    const { store, base, me } = this;
    await store.removeOnDisconnect(`${base}/players/${me.id}`);
    await store.removeOnDisconnect(`${base}/inputs/${me.id}`);
    // Coming back after a reload keeps the original place in the queue (and command).
    const previous = await store.get(`${base}/players/${me.id}`);
    this.joined = previous?.joined ?? Date.now();
    await store.set(`${base}/players/${me.id}`, { name: me.name, joined: this.joined });
    this.unsubscribe.push(
      store.watch(`${base}/players`, players => {
        this.players = players ?? {};
        // The previous connection's onDisconnect can fire after a reload and delete our entry.
        if (!this.leaving && !(me.id in this.players)) {
          store.set(`${base}/players/${me.id}`, { name: me.name, joined: this.joined });
        }
        this.sync();
      }),
      store.watch(`${base}/meta`, meta => {
        this.meta = meta ?? {};
        this.sync();
      }),
      store.watch(`${base}/snap`, snap => {
        this.lastSnap = snap;
        if (this.game.role === 'client') this.game.applySnapshot(snap);
      }),
      store.watch(`${base}/map`, map => {
        this.lastMap = map;
        if (this.game.role === 'client' && map) this.game.applyMap(map.s);
      }),
      store.watch(`${base}/inputs`, inputs => {
        this.inputs = {};
        for (const [id, input] of Object.entries(inputs ?? {})) {
          this.inputs[id] = { direction: ['up', 'right', 'down', 'left'][input.d] ?? null, fire: Boolean(input.f) };
        }
        if (this.game.role === 'host') this.game.setRemoteInputs(this.inputs);
      }),
    );
    this.timer = setInterval(() => this.publish(), snapshotInterval);
  }

  get roster() {
    return Object.entries(this.players)
      .map(([id, player]) => ({ id, name: player.name ?? '', joined: player.joined ?? 0 }))
      .sort((a, b) => a.joined - b.joined || a.id.localeCompare(b.id));
  }

  get commanderId() {
    return this.roster[0]?.id ?? null;
  }

  get isCommander() {
    return this.commanderId === this.me.id;
  }

  get phase() {
    return this.meta.phase === 'playing' ? 'playing' : 'lobby';
  }

  get match() {
    return this.meta.match === 'pvp' ? 'pvp' : 'coop';
  }

  // Bring the local game in line with the room: run it, watch it, or wait in the lobby.
  sync() {
    const { game } = this;
    if (this.phase === 'playing') {
      if (this.meta.host === this.me.id) {
        if (game.role !== 'host') this.startBattle();
        // Tanks of players who left the room drop out instead of idling forever.
        for (const player of game.players) {
          if (player.id !== this.me.id && !(player.id in this.players)) game.retirePlayer(player.id);
        }
      } else if (this.meta.host in this.players) {
        if (game.role !== 'client') {
          game.watch();
          if (this.lastMap) game.applyMap(this.lastMap.s);
        }
      } else if (this.isCommander) {
        // The battle's host left; nobody can continue it, so everyone returns to the lobby.
        this.toLobby();
      }
    } else if (game.role !== 'local') {
      game.reset();
    }
    this.onChange(this);
  }

  setMatch(match) {
    if (this.isCommander) this.store.update(`${this.base}/meta`, { match });
  }

  startBattle() {
    if (!this.isCommander) return;
    const roster = this.roster.slice(0, MAX_CREW);
    this.game.start({ match: this.match, roster, role: 'host' });
    // Inputs only arrive when they change, so seed the new tanks with what is held right now.
    this.game.setRemoteInputs(this.inputs);
    this.sentMap = -1;
    this.store.update(`${this.base}/meta`, {
      phase: 'playing', match: this.match, host: this.me.id, round: (this.meta.round ?? 0) + 1,
    });
  }

  toLobby() {
    if (this.isCommander) this.store.update(`${this.base}/meta`, { phase: 'lobby', host: null });
  }

  sendInput({ direction, fire }) {
    const input = { d: ['up', 'right', 'down', 'left'].indexOf(direction), f: fire ? 1 : 0 };
    const key = `${input.d}:${input.f}`;
    if (key === this.sentInput) return;
    this.sentInput = key;
    this.store.set(`${this.base}/inputs/${this.me.id}`, input);
  }

  publish() {
    const { game } = this;
    if (game.role !== 'host') return;
    if (game.mapVersion !== this.sentMap) {
      this.sentMap = game.mapVersion;
      this.store.set(`${this.base}/map`, { v: game.mapVersion, s: game.encodeMap() });
    }
    this.store.set(`${this.base}/snap`, game.snapshot());
  }

  async leave() {
    this.leaving = true;
    clearInterval(this.timer);
    this.unsubscribe.forEach(stop => stop());
    if (this.game.role === 'host') await this.store.update(`${this.base}/meta`, { phase: 'lobby', host: null });
    await this.store.remove(`${this.base}/inputs/${this.me.id}`);
    await this.store.remove(`${this.base}/players/${this.me.id}`);
    this.game.reset();
  }
}

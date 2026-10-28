'use strict';

/**
 * src/room-manager.js — управление комнатами, игроками и персистентностью.
 *
 * Здесь живёт:
 *   - Room (одна комната: игроки + игра);
 *   - RoomManager (реестр комнат, диспетчер сообщений, сохранение).
 *
 * Инварианты:
 *   1. Один `ws` привязан РОВНО к одному игроку в РОВНО одной комнате
 *      (detachWsFromAllRooms).
 *   2. `player.token` — идентификатор сессии для reconnect.
 *   3. `ws` НЕ сериализуется на диск.
 *   4. После завершения партии любой игрок может запустить новую (restartGame),
 *      при этом комната и игроки сохраняются.
 */

const crypto = require('crypto');
const { Game } = require('./game');
const { createStorage } = require('./storage');

const MAX_PLAYERS = 8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
class Room {
  constructor(id, game) {
    this.id = id;
    this.game = game;
    this.players = [];
    this.createdAt = Date.now();
  }

  addPlayer(name, ws) {
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    this.players.push({ id, name, token, ws, connected: true });
    return { player: this.players[this.players.length - 1], token };
  }

  playersPublic() {
    return this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected }));
  }

  snapshot() {
    return { id: this.id, players: this.playersPublic(), ...this.game.snapshot() };
  }

  toPersisted() {
    return {
      id: this.id, createdAt: this.createdAt,
      game: this.game.toPersisted(),
      players: this.players.map(p => ({ id: p.id, name: p.name, token: p.token })),
    };
  }

  static fromPersisted(d) {
    const room = new Room(d.id, Game.fromPersisted(d.game));
    room.createdAt = d.createdAt;
    room.players = d.players.map(p => ({ ...p, ws: null, connected: false }));
    return room;
  }
}

// ---------------------------------------------------------------------------
// RoomManager
// ---------------------------------------------------------------------------
class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.saveTimer = null;
    this.storage = createStorage();
  }

  // ==========================================================================
  // ПЕРСИСТЕНТНОСТЬ (async: файл или Redis)
  // ==========================================================================

  async load() {
    try {
      const data = await this.storage.load();
      if (!data) return;
      for (const roomData of data.rooms || []) {
        this.rooms.set(roomData.id, Room.fromPersisted(roomData));
      }
      this.cleanupOldRooms();
      console.log(`[persistence] loaded ${this.rooms.size} rooms`);
    } catch (e) {
      console.error('[persistence] load failed:', e);
    }
  }

  cleanupOldRooms() {
    const now = Date.now();
    let removed = 0;
    for (const [id, room] of this.rooms) {
      if (room.game.status !== 'playing' && now - room.createdAt > 3600_000) {
        this.rooms.delete(id);
        removed++;
      }
    }
    if (removed) console.log(`[persistence] cleaned ${removed} finished rooms`);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 150);
  }

  async save() {
    const data = { rooms: [...this.rooms.values()].map(r => r.toPersisted()) };
    try {
      await this.storage.save(data);
    } catch (e) {
      console.error('[persistence] save failed:', e);
    }
  }

  // ==========================================================================
  // УТИЛИТЫ
  // ==========================================================================

  send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcast(room, msg, except = null) {
    for (const p of room.players) {
      if (p.ws && p.ws !== except) this.send(p.ws, msg);
    }
  }

  getRoomForWs(ws) {
    for (const room of this.rooms.values()) {
      if (room.players.some(p => p.ws === ws)) return room;
    }
    return null;
  }

  /**
   * Инвариант: один ws — ровно одна комната.
   * Без этого после повторного createRoom ws оставался бы в старой
   * комнате, и getRoomForWs находил её первой.
   */
  detachWsFromAllRooms(ws) {
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const p of room.players) {
        if (p.ws === ws) {
          p.ws = null;
          p.connected = false;
          changed = true;
        }
      }
      if (changed) {
        this.broadcast(room, { type: 'players', players: room.playersPublic() });
      }
    }
  }

  generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do {
      id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.rooms.has(id));
    return id;
  }

  // ==========================================================================
  // ДИСПЕТЧЕР
  // ==========================================================================

  handleMessage(ws, msg) {
    switch (msg.type) {
      case 'createRoom':  return this.onCreateRoom(ws, msg);
      case 'joinRoom':    return this.onJoinRoom(ws, msg);
      case 'openCell':    return this.onOpenCell(ws, msg);
      case 'toggleFlag':  return this.onToggleFlag(ws, msg);
      case 'leaveRoom':   return this.onLeaveRoom(ws);
      case 'restartGame': return this.onRestartGame(ws);
      case 'ping':        return this.send(ws, { type: 'pong' });
      default:            return this.send(ws, { type: 'error', message: `Unknown: ${msg.type}` });
    }
  }

  // ==========================================================================
  // СОЗДАНИЕ КОМНАТЫ
  // ==========================================================================

  onCreateRoom(ws, msg) {
    this.detachWsFromAllRooms(ws);

    const name = String(msg.name || '').trim().slice(0, 20) || 'Player';
    const rows = clamp(parseInt(msg.rows) || 9, 3, 30);
    const cols = clamp(parseInt(msg.cols) || 9, 3, 30);
    const mines = clamp(parseInt(msg.mines) || 10, 1, rows * cols - 1);

    const roomId = this.generateRoomId();
    const room = new Room(roomId, new Game({ rows, cols, mines }));
    this.rooms.set(roomId, room);

    const { player, token } = room.addPlayer(name, ws);
    console.log(`[createRoom] ${roomId} player=${name} id=${player.id.slice(0, 8)}`);
    this.send(ws, { type: 'joined', roomId, playerId: player.id, token, snapshot: room.snapshot() });
    this.scheduleSave();
  }

  // ==========================================================================
  // ВХОД / RECONNECT
  // ==========================================================================

  onJoinRoom(ws, msg) {
    const roomId = String(msg.code || '').toUpperCase().trim();
    const room = this.rooms.get(roomId);
    if (!room) return this.send(ws, { type: 'error', message: 'Комната не найдена' });

    // RECONNECT по токену
    if (msg.token) {
      const existing = room.players.find(p => p.token === msg.token);
      if (existing) {
        this.detachWsFromAllRooms(ws);
        existing.ws = ws;
        existing.connected = true;
        console.log(`[rejoin] ${roomId} player=${existing.name} id=${existing.id.slice(0, 8)}`);
        this.send(ws, {
          type: 'joined', roomId, playerId: existing.id, token: existing.token,
          snapshot: room.snapshot(),
        });
        this.broadcast(room, { type: 'players', players: room.playersPublic() });
        this.scheduleSave();
        return;
      }
    }

    // FRESH JOIN
    if (room.players.length >= MAX_PLAYERS) return this.send(ws, { type: 'error', message: 'Комната заполнена' });
    // Разрешаем входить в завершённую комнату — но новый игрок не сможет
    // рестартовать её (см. onRestartGame). Он увидит финальное состояние
    // и сможет «Играть заново», если разрешим. Разрешаем — это удобно для
    // наблюдателей, которые присоединяются уже после конца.
    this.detachWsFromAllRooms(ws);

    const name = String(msg.name || '').trim().slice(0, 20) || 'Player';
    const { player, token } = room.addPlayer(name, ws);
    console.log(`[joinRoom] ${roomId} player=${name} id=${player.id.slice(0, 8)}`);
    this.send(ws, { type: 'joined', roomId, playerId: player.id, token, snapshot: room.snapshot() });
    this.broadcast(room, { type: 'players', players: room.playersPublic() });
    this.scheduleSave();
  }

  // ==========================================================================
  // ДЕЙСТВИЯ В ИГРЕ
  // ==========================================================================

  onOpenCell(ws, msg) {
    const room = this.getRoomForWs(ws);
    if (!room) return this.send(ws, { type: 'error', message: 'Не в комнате' });
    const result = room.game.openCell(msg.row, msg.col, msg.expectedVersion);
    this.applyAction(ws, room, result);
  }

  onToggleFlag(ws, msg) {
    const room = this.getRoomForWs(ws);
    if (!room) return this.send(ws, { type: 'error', message: 'Не в комнате' });
    const result = room.game.toggleFlag(msg.row, msg.col, msg.expectedVersion);
    this.applyAction(ws, room, result);
  }

  applyAction(ws, room, result) {
    if (!result.ok) {
      if (result.cell) {
        const cell = room.game.cellForClient(result.cell);
        if (result.reason === 'conflict') {
          this.send(ws, {
            type: 'conflict', row: cell.row, col: cell.col, cell,
            message: 'Клетка изменена другим игроком',
          });
        } else {
          this.send(ws, { type: 'actionRejected', reason: result.reason, cell });
        }
      } else {
        this.send(ws, { type: 'actionRejected', reason: result.reason });
      }
      return;
    }

    const changes = result.changed.map(c => room.game.cellForClient(c));
    this.broadcast(room, { type: 'update', changes, status: result.status });

    if (result.status !== 'playing') {
      this.broadcast(room, { type: 'gameOver', status: result.status, snapshot: room.snapshot() });
    }
    this.scheduleSave();
  }

  // ==========================================================================
  // РЕСТАРТ: новое поле, та же комната и игроки
  // ==========================================================================

  onRestartGame(ws) {
    const room = this.getRoomForWs(ws);
    if (!room) return this.send(ws, { type: 'error', message: 'Не в комнате' });

    // Рестарт возможен только после завершения партии.
    if (room.game.status === 'playing') {
      return this.send(ws, { type: 'error', message: 'Игра ещё идёт' });
    }

    // Новый Game с теми же параметрами поля. Старые мины/состояния отбрасываются.
    room.game = new Game({
      rows: room.game.rows,
      cols: room.game.cols,
      mines: room.game.mines,
    });

    console.log(`[restart] ${room.id}`);

    // Полный snapshot всем: у клиентов подменится доска, статус, версии клеток.
    this.broadcast(room, {
      type: 'restarted',
      snapshot: room.snapshot(),
    });

    this.scheduleSave();
  }

  // ==========================================================================
  // ВЫХОД И РАЗРЫВ
  // ==========================================================================

  /** Явный «Выйти из комнаты» — игрок удаляется (не просто offline). */
  onLeaveRoom(ws) {
    const room = this.getRoomForWs(ws);
    if (!room) return;
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx >= 0) {
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      console.log(`[leaveRoom] ${room.id} player=${name}`);
      this.broadcast(room, { type: 'players', players: room.playersPublic() });
      this.scheduleSave();
    }
  }

  /** Разрыв (закрытие вкладки, обрыв сети) — игрок становится offline. */
  handleDisconnect(ws) {
    const room = this.getRoomForWs(ws);
    if (!room) return;
    const player = room.players.find(p => p.ws === ws);
    if (player) {
      player.ws = null;
      player.connected = false;
      this.broadcast(room, { type: 'players', players: room.playersPublic() });
      this.scheduleSave();
    }
  }
}

module.exports = { RoomManager };
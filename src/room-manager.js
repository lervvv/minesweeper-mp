'use strict';

/**
 * src/room-manager.js — управление комнатами, игроками и персистентностью.
 *
 * Здесь живёт:
 *   - Room (одна комната: игроки + игра);
 *   - RoomManager (реестр комнат, диспетчер сообщений, сохранение на диск).
 *
 * Ключевые инварианты:
 *   1. Один `ws` привязан РОВНО к одному игроку в РОВНО одной комнате.
 *      Достигается через detachWsFromAllRooms(ws).
 *   2. `player.token` — идентификатор сессии. По нему делается reconnect.
 *   3. `ws` НЕ сериализуется на диск — он рантайм-объект.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');         // для randomUUID (id игрока и токен)
const { Game } = require('./game');

const MAX_PLAYERS = 8;
// Утилита: зажать значение в диапазон [lo, hi].
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Room — одна комната: игра + список игроков
// ---------------------------------------------------------------------------
class Room {
  constructor(id, game) {
    this.id = id;                 // 'ABCDE'
    this.game = game;             // экземпляр Game
    this.players = [];            // [{ id, name, token, ws, connected }]
    this.createdAt = Date.now();  // нужно для очистки старых комнат
  }

  /**
   * Добавить игрока. Вызывается при createRoom и при fresh join.
   * Возвращает ссылку на игрока и его токен (для отправки клиенту).
   */
  addPlayer(name, ws) {
    const id = crypto.randomUUID();
    const token = crypto.randomUUID(); // ← session identifier
    this.players.push({ id, name, token, ws, connected: true });
    return { player: this.players[this.players.length - 1], token };
  }

  /** Публичная информация об игроках — без token и без ws. */
  playersPublic() {
    return this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected }));
  }

  /** Полный снимок для клиента: id комнаты + игроки + состояние игры. */
  snapshot() {
    return { id: this.id, players: this.playersPublic(), ...this.game.snapshot() };
  }

  /**
   * Снимок для диска.
   * ВАЖНО: `ws` не включаем (это объект-сокет, не сериализуется).
   * `token` включаем — без него невозможен reconnect после рестарта.
   */
  toPersisted() {
    return {
      id: this.id, createdAt: this.createdAt,
      game: this.game.toPersisted(),
      players: this.players.map(p => ({ id: p.id, name: p.name, token: p.token })),
    };
  }

  /**
   * Восстановление из диска: все игроки приходят «offline» (ws: null).
   * Когда кто-то вернётся с токеном — onJoinRoom привяжет к нему новый ws.
   */
  static fromPersisted(d) {
    const room = new Room(d.id, Game.fromPersisted(d.game));
    room.createdAt = d.createdAt;
    room.players = d.players.map(p => ({ ...p, ws: null, connected: false }));
    return room;
  }
}

// ---------------------------------------------------------------------------
// RoomManager — реестр комнат + диспетчер + персистентность
// ---------------------------------------------------------------------------
const { createStorage } = require('./storage');
class RoomManager {
  constructor() {
    this.storage = createStorage();
    this.rooms = new Map();  // roomId → Room
    this.saveTimer = null;   // для дебаунса записи на диск
  }

  // ==========================================================================
  // ПЕРСИСТЕНТНОСТЬ
  // ==========================================================================

  /** Загрузка при старте сервера. Тихо выходим, если файла ещё нет. */
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

  /** Удаляем завершённые игры старше часа, чтобы файл не рос бесконечно. */
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

  /**
   * Дебаунс записи. Каскадное открытие может изменить 30+ клеток за раз —
   * писать файл на каждый чих нерационально. Пишем не чаще раза в 150 мс.
   */
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 150);
  }

  /**
   * Атомарная запись: сначала во временный .tmp, потом renameSync.
   * Если сервер упадёт посреди записи — старый файл остаётся целым.
   */
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

  /** Отправить JSON-сообщение в сокет, если он открыт. */
  send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  /** Разослать сообщение всем игрокам комнаты (при желании — кроме одного). */
  broadcast(room, msg, except = null) {
    for (const p of room.players) {
      if (p.ws && p.ws !== except) this.send(p.ws, msg);
    }
  }

  /**
   * Найти комнату по сокету. Используется во всех «действиях» (openCell и т.п.),
   * чтобы понять, к какой комнате относится клиент.
   */
  getRoomForWs(ws) {
    for (const room of this.rooms.values()) {
      if (room.players.some(p => p.ws === ws)) return room;
    }
    return null;
  }

  /**
   * КРИТИЧНО. Инвариант: один ws — ровно одна комната.
   * Без этого вызова при повторном createRoom без перезагрузки старый ws
   * оставался в старой комнате, и getRoomForWs находил её первой.
   * Клики уходили в старую комнату → клетки «не нажимались» до F5.
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
        // Остальные игроки этой комнаты должны увидеть, что партнёр offline.
        this.broadcast(room, { type: 'players', players: room.playersPublic() });
      }
    }
  }

  /** Случайный 5-символьный код комнаты. Без похожих символов (0/O, 1/I). */
  generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do {
      id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.rooms.has(id)); // защита от коллизий
    return id;
  }

  // ==========================================================================
  // ДИСПЕТЧЕР СООБЩЕНИЙ
  // ==========================================================================

  handleMessage(ws, msg) {
    switch (msg.type) {
      case 'createRoom': return this.onCreateRoom(ws, msg);
      case 'joinRoom':   return this.onJoinRoom(ws, msg);
      case 'openCell':   return this.onOpenCell(ws, msg);
      case 'toggleFlag': return this.onToggleFlag(ws, msg);
      case 'leaveRoom':  return this.onLeaveRoom(ws);
      case 'ping':       return this.send(ws, { type: 'pong' });
      default:           return this.send(ws, { type: 'error', message: `Unknown: ${msg.type}` });
    }
  }

  // ==========================================================================
  // СОЗДАНИЕ КОМНАТЫ
  // ==========================================================================

  onCreateRoom(ws, msg) {
    // Сначала отвязать ws от других комнат (см. детали в detachWsFromAllRooms).
    this.detachWsFromAllRooms(ws);

    // Санитизация параметров: обрезаем имя, зажимаем размеры поля.
    const name = String(msg.name || '').trim().slice(0, 20) || 'Player';
    const rows = clamp(parseInt(msg.rows) || 9, 3, 30);
    const cols = clamp(parseInt(msg.cols) || 9, 3, 30);
    const mines = clamp(parseInt(msg.mines) || 10, 1, rows * cols - 1);

    const roomId = this.generateRoomId();
    const room = new Room(roomId, new Game({ rows, cols, mines }));
    this.rooms.set(roomId, room);

    const { player, token } = room.addPlayer(name, ws);
    console.log(`[createRoom] ${roomId} player=${name} id=${player.id.slice(0, 8)}`);

    // Отправляем только создателю: roomId + playerId + token + полный snapshot.
    // Клиент сохранит token в sessionStorage — это и есть «сессия».
    this.send(ws, { type: 'joined', roomId, playerId: player.id, token, snapshot: room.snapshot() });
    this.scheduleSave();
  }

  // ==========================================================================
  // ВХОД В КОМНАТУ (включая reconnect по токену)
  // ==========================================================================

  onJoinRoom(ws, msg) {
    const roomId = String(msg.code || '').toUpperCase().trim();
    const room = this.rooms.get(roomId);
    if (!room) return this.send(ws, { type: 'error', message: 'Комната не найдена' });

    // ---- (A) RECONNECT: клиент прислал token → ищем того же игрока ----
    if (msg.token) {
      const existing = room.players.find(p => p.token === msg.token);
      if (existing) {
        // Инвариант: ws привязан ровно к одной комнате.
        this.detachWsFromAllRooms(ws);
        // Перепривязка: новый сокет к старому игроку.
        // id/name/token НЕ меняются — это тот же человек.
        existing.ws = ws;
        existing.connected = true;
        console.log(`[rejoin] ${roomId} player=${existing.name} id=${existing.id.slice(0, 8)}`);

        // Полный snapshot — клиент подменит всё локальное состояние.
        // Никаких «догоняющих» апдейтов: накопленная очередь клиентом сброшена.
        this.send(ws, {
          type: 'joined', roomId, playerId: existing.id, token: existing.token,
          snapshot: room.snapshot(),
        });
        // Остальным — обновлённый список игроков (партнёр вернулся в online).
        this.broadcast(room, { type: 'players', players: room.playersPublic() });
        this.scheduleSave();
        return;
      }
      // Токен передан, но игрок с таким токеном не найден — идём во fresh join.
    }

    // ---- (B) FRESH JOIN: новый игрок ----
    if (room.players.length >= MAX_PLAYERS) return this.send(ws, { type: 'error', message: 'Комната заполнена' });
    if (room.game.status !== 'playing') return this.send(ws, { type: 'error', message: 'Игра уже завершена' });

    this.detachWsFromAllRooms(ws);

    const name = String(msg.name || '').trim().slice(0, 20) || 'Player';
    const { player, token } = room.addPlayer(name, ws);
    console.log(`[joinRoom] ${roomId} player=${name} id=${player.id.slice(0, 8)}`);

    this.send(ws, { type: 'joined', roomId, playerId: player.id, token, snapshot: room.snapshot() });
    // Уже присутствующим — обновление списка игроков.
    this.broadcast(room, { type: 'players', players: room.playersPublic() });
    this.scheduleSave();
  }

  // ==========================================================================
  // ДЕЙСТВИЯ В ИГРЕ
  // ==========================================================================

  onOpenCell(ws, msg) {
    const room = this.getRoomForWs(ws);
    if (!room) return this.send(ws, { type: 'error', message: 'Не в комнате' });
    // expectedVersion пробрасывается в Game.openCell — там делается проверка.
    const result = room.game.openCell(msg.row, msg.col, msg.expectedVersion);
    this.applyAction(ws, room, result);
  }

  onToggleFlag(ws, msg) {
    const room = this.getRoomForWs(ws);
    if (!room) return this.send(ws, { type: 'error', message: 'Не в комнате' });
    const result = room.game.toggleFlag(msg.row, msg.col, msg.expectedVersion);
    this.applyAction(ws, room, result);
  }

  /**
   * Универсальная обработка результата действия.
   * Здесь происходит вся синхронизация по WebSocket:
   *   - успех → broadcast всем (включая отправителя);
   *   - конфликт → ответ ТОЛЬКО отправителю, с актуальной клеткой;
   *   - другие отказы → ответ только отправителю.
   */
  applyAction(ws, room, result) {
    if (!result.ok) {
      if (result.cell) {
        const cell = room.game.cellForClient(result.cell); // безопасная сериализация
        if (result.reason === 'conflict') {
          // Кто-то успел раньше: отправляем актуальное состояние клетки.
          // Broadcast не нужен — остальные уже получили update от победителя.
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

    // ---- УСПЕХ: главный «вещатель» мгновенной синхронизации ----
    const changes = result.changed.map(c => room.game.cellForClient(c));
    this.broadcast(room, { type: 'update', changes, status: result.status });

    // Если игра закончилась — шлём полный snapshot для гарантированной
    // консистентности (на случай, если клиент отстал).
    if (result.status !== 'playing') {
      this.broadcast(room, { type: 'gameOver', status: result.status, snapshot: room.snapshot() });
    }

    this.scheduleSave();
  }

  // ==========================================================================
  // ВЫХОД ИЗ КОМНАТЫ
  // ==========================================================================

  /** Явный «Выйти» — игрок удаляется из комнаты (не просто offline). */
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

  /**
   * Разрыв соединения (ws.on('close') или heartbeat terminate).
   * Игрока НЕ удаляем — только помечаем offline. Это позволяет
   * вернуться по токену. Удаление — только через onLeaveRoom.
   */
  handleDisconnect(ws) {
    const room = this.getRoomForWs(ws);
    if (!room) return;
    const player = room.players.find(p => p.ws === ws);
    if (player) {
      player.ws = null;
      player.connected = false;
      // Остальные видят «(offline)» в списке игроков.
      this.broadcast(room, { type: 'players', players: room.playersPublic() });
      // Сохраняем, чтобы после рестарта сервера игрок был в rooms.json с токеном.
      this.scheduleSave();
    }
  }
}

module.exports = { RoomManager };
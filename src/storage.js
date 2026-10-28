'use strict';

/**
 * Абстракция хранилища: Redis (production) или файл (local).
 * Если задан REDIS_URL — используем Redis, иначе — файл.
 */

const fs = require('fs');
const path = require('path');

class FileStorage {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      console.error('[storage:file] load failed:', e);
      return null;
    }
  }

  async save(data) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.filePath);
  }
}

class RedisStorage {
  constructor(url) {
    // ленивая инициализация — клиент создаётся при первом использовании
    this.url = url;
    this.client = null;
  }

  async getClient() {
    if (this.client) return this.client;
    const { createClient } = require('redis');
    this.client = createClient({ url: this.url });
    this.client.on('error', (e) => console.error('[storage:redis] error:', e));
    await this.client.connect();
    return this.client;
  }

  async load() {
    const client = await this.getClient();
    const raw = await client.get('minesweeper:rooms');
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  async save(data) {
    const client = await this.getClient();
    await client.set('minesweeper:rooms', JSON.stringify(data));
  }
}

function createStorage() {
  if (process.env.REDIS_URL) {
    console.log('[storage] using Redis');
    return new RedisStorage(process.env.REDIS_URL);
  }
  console.log('[storage] using file');
  const filePath = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'rooms.json');
  return new FileStorage(filePath);
}

module.exports = { createStorage };
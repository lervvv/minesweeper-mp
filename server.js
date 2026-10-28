'use strict';

/**
 * server.js — точка входа приложения.
 *
 * Отвечает за три вещи:
 *   1. HTTP-сервер для раздачи статики (index.html, style.css, app.js).
 *   2. WebSocket-сервер на ТОМ ЖЕ порту (через HTTP Upgrade handshake).
 *   3. Heartbeat ping/pong для отсечения «мёртвых» TCP-соединений.
 *
 * Логика игры и комнат вынесена в RoomManager (src/room-manager.js).
 * Хранилище (файл локально / Redis на хостинге) — в src/storage.js.
 * Здесь — только транспорт и жизненный цикл сокетов.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./src/room-manager');

// Порт и хост. PORT пригодится при деплое — хостинги (Render, Railway)
// передают его через переменную окружения. HOST=0.0.0.0 означает
// «слушать на всех сетевых интерфейсах», иначе сервер был бы доступен
// только с localhost и тесты с телефона в локальной сети не работали бы.
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Каталог со статикой. Путь к хранилищу больше здесь не нужен —
// его выбирает src/storage.js (файл или Redis по env).
const PUBLIC_DIR = path.join(__dirname, 'public');

// Карта расширений → MIME-типы. Нужна, чтобы браузер корректно
// интерпретировал app.js как JS, style.css как CSS и т.д.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// HTTP-сервер: раздаёт статику из public/
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Парсим URL, чтобы отделить pathname от query-строки.
  const url = new URL(req.url, `http://${req.headers.host}`);
  // '/' → 'index.html', остальное — как есть, но без ведущих слешей.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);

  // Защита от path traversal: если после resolve путь вышел за пределы
  // public/ (например, '../../etc/passwd'), отдаём 403.
  // path.sep — разделитель пути в текущей ОС ('/' или '\\').
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // Читаем файл с диска асинхронно — не блокируем event loop.
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket-сервер «поверх» того же HTTP-сервера
// ---------------------------------------------------------------------------
// { server } означает: ws-библиотека подписывается на событие 'upgrade'
// у http.Server. Когда приходит HTTP-запрос с 'Upgrade: websocket',
// библиотека делает 101 Switching Protocols и создаёт WS-объект.
// Обычные GET-запросы по-прежнему идут в http.createServer выше.
const wss = new WebSocketServer({ server });

// RoomManager — вся логика комнат, игроков и персистентности.
// Конструктор без аргументов: хранилище выбирается внутри
// через createStorage() (файл или Redis по env REDIS_URL).
const manager = new RoomManager();

// На каждое новое WebSocket-соединение создаётся свой объект `ws`.
wss.on('connection', (ws) => {
  // Флаг для heartbeat: пока true — сокет считаем живым.
  ws.isAlive = true;

  // Браузер автоматически отвечает pong на ping — это делает сам WebSocket API.
  // Нам достаточно поднять флаг «клиент ответил».
  ws.on('pong', () => { ws.isAlive = true; });

  // Обработка входящего сообщения.
  ws.on('message', (raw) => {
    let msg;
    try {
      // raw — Buffer; toString() → строка; JSON.parse → объект.
      msg = JSON.parse(raw.toString());
    } catch {
      // Битый JSON не должен ронять сервер.
      return ws.send(JSON.stringify({ type: 'error', message: 'Bad JSON' }));
    }
    try {
      // Диспетчеризация: createRoom / joinRoom / openCell / toggleFlag / ...
      manager.handleMessage(ws, msg);
    } catch (e) {
      // Если внутри логики что-то упало — не даём процессу умереть.
      console.error('[ws] handler error:', e);
    }
  });

  // Разрыв соединения: помечаем игрока offline, но НЕ удаляем его из комнаты.
  // Токен и identity остаются — он сможет вернуться.
  ws.on('close', () => manager.handleDisconnect(ws));
});

// ---------------------------------------------------------------------------
// Heartbeat: раз в 30 секунд проверяем, живы ли клиенты
// ---------------------------------------------------------------------------
// Зачем: TCP сам не детектит «hung»-соединения, когда клиент исчез без FIN
// (мобильные сети, сон ноутбука, выключенный Wi-Fi). Тогда ws.on('close')
// не срабатывает, а сокет висит в wss.clients как призрак.
//
// Алгоритм:
//   - если флаг isAlive === false (прошлый ping не получил pong) → terminate
//   - иначе isAlive = false и шлём ping
//   - если клиент живой, он автоматически ответит pong → флаг вернётся в true
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate(); // принудительный RST
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

// ---------------------------------------------------------------------------
// Старт: сначала загружаем комнаты, потом начинаем принимать соединения
// ---------------------------------------------------------------------------
// manager.load() теперь асинхронный (может читать файл или Redis).
// Мы НЕ начинаем listen до тех пор, пока данные не загружены — иначе
// возможна ситуация, когда клиент подключается раньше, чем комнаты
// восстановлены из хранилища, и видит пустое состояние.
//
// Если Redis недоступен / файл битый — load() не бросает исключение
// наружу, а логирует ошибку и возвращает управление. Поэтому сервер
// всё равно стартует — просто с пустой картой комнат.
manager.load()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[server] listening on ${HOST}:${PORT}`);
      console.log(`→ local:  http://localhost:${PORT}`);
      console.log(`→ LAN:    http://<your-ip>:${PORT}`);
      if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`→ public: ${process.env.RENDER_EXTERNAL_URL}`);
      }
      if (process.env.REDIS_URL) {
        console.log(`[storage] persistent via Redis`);
      } else {
        console.log(`[storage] persistent via local file (data/rooms.json)`);
      }
    });
  })
  .catch((e) => {
    // На всякий случай: если load() когда-нибудь начнёт кидать исключения,
    // мы всё равно поднимем сервер — лучше пустая игра, чем мёртвый сервис.
    console.error('[server] load failed, starting with empty state:', e);
    server.listen(PORT, HOST, () => {
      console.log(`[server] listening on ${HOST}:${PORT} (empty state)`);
    });
  });
'use strict';
(() => {
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const SESSION_KEY = 'ms:session';

  const state = {
    ws: null,
    connected: false,
    roomId: null,
    playerId: null,
    token: null,
    snapshot: null,
    cells: new Map(),
    sendQueue: [],
    reconnectAttempts: 0,
    autoRejoin: null,
    pendingRejoin: false,
  };

  let creatingRoom = false;

  const el = {
    status:     document.getElementById('status'),
    lobby:      document.getElementById('lobby'),
    game:       document.getElementById('game'),
    lobbyError: document.getElementById('lobby-error'),
    board:      document.getElementById('board'),
    roomCode:   document.getElementById('room-code'),
    minesLeft:  document.getElementById('mines-left'),
    gameStatus: document.getElementById('game-status'),
    players:    document.getElementById('players'),
    banner:     document.getElementById('banner'),
    btnRestart: document.getElementById('btn-restart'),
  };

  const key = (r, c) => `${r},${c}`;

  // ---------- WebSocket ----------
  function connect() {
    setStatus('Подключение…', 'pending');
    const ws = new WebSocket(WS_URL);
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      state.reconnectAttempts = 0;
      setStatus('Онлайн', 'ok');

      if (state.autoRejoin) {
        state.sendQueue = [];
        state.pendingRejoin = true;
        send({ type: 'joinRoom', code: state.autoRejoin.roomId, token: state.autoRejoin.token });
      } else {
        flushQueue();
      }
    };

    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      state.connected = false;
      setStatus('Переподключение…', 'pending');
      if (state.roomId && state.token) {
        state.autoRejoin = { roomId: state.roomId, token: state.token };
      }
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose сработает следом */ };
  }

  function scheduleReconnect() {
    const delay = Math.min(500 * 2 ** state.reconnectAttempts, 10_000);
    state.reconnectAttempts++;
    setTimeout(() => { if (!state.connected) connect(); }, delay);
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    } else {
      state.sendQueue.push(msg);
    }
  }

  function flushQueue() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const q = state.sendQueue; state.sendQueue = [];
    for (const m of q) state.ws.send(JSON.stringify(m));
  }

  // ---------- Session ----------
  function saveSession() {
    if (!state.roomId || !state.token) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      roomId: state.roomId, token: state.token,
      name: (state.snapshot?.players.find(p => p.id === state.playerId)?.name) || '',
    }));
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }
  function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

  // ---------- Message dispatch ----------
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'joined':         return onJoined(msg);
      case 'players':        return onPlayers(msg);
      case 'update':         return onUpdate(msg);
      case 'conflict':       return onConflict(msg);
      case 'gameOver':       return onGameOver(msg);
      case 'actionRejected': return onRejected(msg);
      case 'restarted':      return onRestarted(msg);
      case 'error':          return onError(msg);
    }
  }

  function onJoined(msg) {
    console.log('[joined]', msg.roomId, 'cells:', msg.snapshot?.cells?.length);
    creatingRoom = false;
    state.autoRejoin = null;
    state.pendingRejoin = false;
    state.roomId = msg.roomId;
    state.playerId = msg.playerId;
    state.token = msg.token;
    applySnapshot(msg.snapshot);
    saveSession();
    showGame();
  }

  function onPlayers(msg) {
    if (!state.snapshot) return;
    state.snapshot.players = msg.players;
    renderPlayers();
  }

  function onUpdate(msg) {
    if (!state.snapshot) return;
    console.log('[update]', msg.changes.length, 'cells, status =', msg.status);
    for (const c of msg.changes) {
      state.cells.set(key(c.row, c.col), c);
      renderCell(c);
    }
    state.snapshot.status = msg.status;
    renderHeader();
  }

  function onConflict(msg) {
    console.log('[conflict]', msg.row, msg.col, msg.message);
    if (msg.cell) {
      state.cells.set(key(msg.cell.row, msg.cell.col), msg.cell);
      renderCell(msg.cell);
    }
    flashStatus('Конфликт: ' + (msg.message || 'клетка изменена'), 'bad');
  }

  function onRejected(msg) {
    console.warn('[rejected]', msg.reason, msg.cell || '');
    if (msg.cell) {
      state.cells.set(key(msg.cell.row, msg.cell.col), msg.cell);
      renderCell(msg.cell);
    }
  }

  function onGameOver(msg) {
    console.log('[gameOver]', msg.status);
    applySnapshot(msg.snapshot);
    showBanner(msg.status === 'won');
  }

  function onRestarted(msg) {
    console.log('[restarted]', msg.snapshot?.id);
    applySnapshot(msg.snapshot);
    // renderAll() скроет баннер и кнопку «Заново», потому что status = playing.
  }

  function onError(msg) {
    console.error('[server error]', msg.message);
    if (state.pendingRejoin) {
      state.pendingRejoin = false;
      state.autoRejoin = null;
      goToLobby();
      el.lobbyError.textContent = msg.message || 'Не удалось восстановить игру';
      return;
    }
    if (!state.snapshot) {
      creatingRoom = false;
      el.lobbyError.textContent = msg.message || 'Ошибка';
    } else {
      flashStatus(msg.message, 'bad');
    }
  }

  // ---------- Rendering ----------
  function applySnapshot(snap) {
    state.snapshot = snap;
    state.cells = new Map();
    for (const c of snap.cells) state.cells.set(key(c.row, c.col), c);
    renderAll();
  }

  function showLobby() {
    el.lobby.classList.remove('hidden');
    el.game.classList.add('hidden');
    el.banner.classList.add('hidden');
  }

  function showGame() {
    el.lobby.classList.add('hidden');
    el.game.classList.remove('hidden');
    el.lobbyError.textContent = '';
  }

  function renderAll() {
    if (!state.snapshot) return;
    renderHeader();
    renderPlayers();
    renderBoard();

    const finished = state.snapshot.status !== 'playing';
    if (finished) showBanner(state.snapshot.status === 'won');
    else hideBanner();

    // Кнопка «Играть заново» видна только когда партия завершена.
    el.btnRestart.classList.toggle('hidden', !finished);
  }

  function renderHeader() {
    el.roomCode.textContent = state.snapshot.id;
    const flagged = [...state.cells.values()].filter(c => c.state === 'flagged').length;
    el.minesLeft.textContent = state.snapshot.mines - flagged;
    el.gameStatus.textContent = ({ playing: 'В игре', won: 'Победа', lost: 'Проигрыш' })[state.snapshot.status];
  }

  function renderPlayers() {
    el.players.innerHTML = '';
    for (const p of state.snapshot.players) {
      const d = document.createElement('div');
      d.className = 'player' + (p.connected ? '' : ' offline') + (p.id === state.playerId ? ' self' : '');
      d.textContent = p.name + (p.connected ? '' : ' (offline)');
      el.players.appendChild(d);
    }
  }

  function renderBoard() {
    el.board.innerHTML = '';
    el.board.style.gridTemplateColumns = `repeat(${state.snapshot.cols}, 32px)`;
    for (let r = 0; r < state.snapshot.rows; r++) {
      for (let c = 0; c < state.snapshot.cols; c++) {
        el.board.appendChild(createCellEl(state.cells.get(key(r, c))));
      }
    }
  }

  function createCellEl(cell) {
    const d = document.createElement('div');
    d.dataset.row = String(cell.row);
    d.dataset.col = String(cell.col);
    updateCellEl(d, cell);
    return d;
  }

  function renderCell(cell) {
    const d = el.board.querySelector(
      `.cell[data-row="${cell.row}"][data-col="${cell.col}"]`
    );
    if (d) updateCellEl(d, cell);
  }

  function updateCellEl(d, cell) {
    d.className = 'cell';
    d.dataset.n = '';
    d.textContent = '';
    if (cell.state === 'flagged') {
      d.classList.add('flagged');
      d.textContent = '🚩';
    } else if (cell.state === 'revealed') {
      d.classList.add('revealed');
      if (cell.mine) {
        d.classList.add('mine');
        d.textContent = '💥';
      } else if (cell.adjacent > 0) {
        d.dataset.n = String(cell.adjacent);
        d.textContent = String(cell.adjacent);
      }
    }
  }

  function showBanner(win) {
    el.banner.className = 'banner ' + (win ? 'win' : 'lose');
    el.banner.textContent = win ? '🏆 Победа! Все мины найдены' : '💥 Взрыв! Игра окончена';
    el.banner.classList.remove('hidden');
  }

  function hideBanner() {
    el.banner.className = 'banner hidden';
    el.banner.textContent = '';
  }

  // ---------- Actions ----------
  function tryOpen(row, col) {
    if (!state.snapshot) { console.warn('[tryOpen] snapshot missing'); return; }
    if (state.snapshot.status !== 'playing') {
      console.warn('[tryOpen] not playing:', state.snapshot.status);
      return;
    }
    const cell = state.cells.get(key(row, col));
    if (!cell) { console.warn('[tryOpen] cell not found', row, col); return; }
    if (cell.state !== 'hidden') { console.warn('[tryOpen] cell is', cell.state); return; }
    console.log('[open]', row, col, 'v', cell.version);
    send({ type: 'openCell', row, col, expectedVersion: cell.version });
  }

  function tryFlag(row, col) {
    if (!state.snapshot) { console.warn('[tryFlag] snapshot missing'); return; }
    if (state.snapshot.status !== 'playing') { console.warn('[tryFlag] status:', state.snapshot.status); return; }
    const cell = state.cells.get(key(row, col));
    if (!cell) { console.warn('[tryFlag] cell not found', row, col); return; }
    if (cell.state === 'revealed') { console.warn('[tryFlag] already revealed'); return; }
    console.log('[flag]', row, col, 'v', cell.version);
    send({ type: 'toggleFlag', row, col, expectedVersion: cell.version });
  }

  // ---------- Status pill ----------
  let statusTimer = null;
  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status ' + (kind || '');
  }
  function flashStatus(text, kind) {
    setStatus(text, kind);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      setStatus(state.connected ? 'Онлайн' : 'Оффлайн', state.connected ? 'ok' : 'bad');
    }, 3000);
  }

  // ---------- Полный сброс состояния ----------
  function goToLobby() {
    clearSession();
    state.roomId = null;
    state.playerId = null;
    state.token = null;
    state.snapshot = null;
    state.cells = new Map();
    state.autoRejoin = null;
    state.pendingRejoin = false;
    state.sendQueue = [];
    creatingRoom = false;

    el.board.innerHTML = '';
    el.players.innerHTML = '';
    hideBanner();
    el.btnRestart.classList.add('hidden');
    el.lobbyError.textContent = '';

    showLobby();
    flushQueue();
  }

  // ---------- Кнопки ----------
  document.getElementById('btn-create').addEventListener('click', () => {
    if (creatingRoom) return;
    creatingRoom = true;
    el.lobbyError.textContent = '';

    state.autoRejoin = null;
    state.pendingRejoin = false;
    state.sendQueue = [];
    clearSession();

    send({
      type: 'createRoom',
      name: document.getElementById('create-name').value.trim() || 'Игрок',
      rows: parseInt(document.getElementById('create-rows').value) || 9,
      cols: parseInt(document.getElementById('create-cols').value) || 9,
      mines: parseInt(document.getElementById('create-mines').value) || 10,
    });
    setTimeout(() => { creatingRoom = false; }, 2000);
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    state.autoRejoin = null;
    clearSession();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!code) { el.lobbyError.textContent = 'Введите код'; return; }
    el.lobbyError.textContent = '';
    send({
      type: 'joinRoom',
      name: document.getElementById('join-name').value.trim() || 'Игрок',
      code,
    });
  });

  document.getElementById('btn-leave').addEventListener('click', () => {
    send({ type: 'leaveRoom' });
    goToLobby();
  });

  el.btnRestart.addEventListener('click', () => {
    el.btnRestart.classList.add('hidden'); // защита от даблклика
    send({ type: 'restartGame' });
  });

  // ---------- Делегирование на доску ----------
  el.board.addEventListener('click', (e) => {
    const cellEl = e.target.closest('.cell');
    if (!cellEl || !el.board.contains(cellEl)) return;
    const row = parseInt(cellEl.dataset.row, 10);
    const col = parseInt(cellEl.dataset.col, 10);
    if (Number.isNaN(row) || Number.isNaN(col)) return;
    tryOpen(row, col);
  });

  el.board.addEventListener('contextmenu', (e) => {
    const cellEl = e.target.closest('.cell');
    if (!cellEl || !el.board.contains(cellEl)) return;
    e.preventDefault();
    const row = parseInt(cellEl.dataset.row, 10);
    const col = parseInt(cellEl.dataset.col, 10);
    if (Number.isNaN(row) || Number.isNaN(col)) return;
    tryFlag(row, col);
  });

  // ---------- Boot ----------
  const saved = loadSession();
  if (saved) {
    state.autoRejoin = { roomId: saved.roomId, token: saved.token };
    document.getElementById('join-code').value = saved.roomId || '';
    document.getElementById('join-name').value = saved.name || '';
  }
  showLobby();
  connect();
})();
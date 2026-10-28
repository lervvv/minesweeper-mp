'use strict';

class Game {
  constructor({ rows, cols, mines }) {
    this.rows = rows;
    this.cols = cols;
    this.mines = mines;
    this.status = 'playing'; // 'playing' | 'won' | 'lost'
    this.cells = [];          // плоский массив всех клеток
    this.generate();
  }

  /**
   * Генерация поля: случайное распределение мин + подсчёт соседей.
   * Мины ставятся через Set, чтобы избежать дубликатов индексов.
   */
  generate() {
    const total = this.rows * this.cols;
    const mineSet = new Set();
    while (mineSet.size < this.mines) {
      mineSet.add(Math.floor(Math.random() * total));
    }

    // Заполняем клетки. Порядок в массиве: индекс = row * cols + col,
    // это позволяет быстро получать клетку по координатам.
    for (let i = 0; i < total; i++) {
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      this.cells.push({
        row, col,
        mine: mineSet.has(i),   // мина здесь?
        adjacent: 0,            // сколько мин в 8 соседях
        state: 'hidden',        // 'hidden' | 'flagged' | 'revealed'
        version: 0,             // ← ключ к optimistic concurrency (конфликты)
      });
    }

    // Вторым проходом считаем adjacent для не-минных клеток.
    for (const cell of this.cells) {
      if (cell.mine) continue;
      cell.adjacent = this.neighbors(cell.row, cell.col).filter(c => c.mine).length;
    }
  }

  /**
   * Все соседи (максимум 8) с учётом границ поля.
   * Возвращает массив ссылок на клетки — удобно для каскадов.
   */
  neighbors(row, col) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue; // сама клетка не считается
        const r = row + dr, c = col + dc;
        if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
          out.push(this.cells[r * this.cols + c]);
        }
      }
    }
    return out;
  }

  /** Безопасное получение клетки. null, если за пределами поля. */
  getCell(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return null;
    return this.cells[row * this.cols + col];
  }


  /**
   * Открыть клетку.
   * @param {number} row
   * @param {number} col
   * @param {number} [expectedVersion] — какую версию клетки видел клиент.
   *   Если не совпало с актуальной → конфликт (кто-то успел раньше).
   */
  openCell(row, col, expectedVersion) {
    const cell = this.getCell(row, col);
    if (!cell) return { ok: false, reason: 'out_of_bounds' };
    if (this.status !== 'playing') return { ok: false, reason: 'game_over' };

    // Optimistic concurrency: клиент должен предъявить актуальную версию.
    // Проверка `expectedVersion !== undefined` позволяет вызывать метод
    // без версии (например, изнутри), но клиент ВСЕГДА передаёт её.
    if (expectedVersion !== undefined && cell.version !== expectedVersion) {
      return { ok: false, reason: 'conflict', cell };
    }

    // Дополнительные проверки состояния клетки.
    if (cell.state === 'revealed') return { ok: false, reason: 'already_revealed', cell };
    if (cell.state === 'flagged')  return { ok: false, reason: 'flagged', cell };

    const changed = []; // накопим все изменённые клетки для broadcast

    if (cell.mine) {
      // Взорвались: раскрываем клетку, статус = lost, показываем все мины.
      this.revealCell(cell, changed);
      this.status = 'lost';
      this.revealAllMines(changed);
    } else {
      // Обычное открытие с каскадом пустых клеток.
      this.revealCascade(cell, changed);
      this.checkWin();
      // Если победа — тоже показываем все мины (традиция сапёра).
      if (this.status === 'won') this.revealAllMines(changed);
    }

    return { ok: true, changed, status: this.status };
  }

  /**
   * Поставить/снять флаг. Флаг = «здесь мина, не трогать».
   * На раскрытую клетку флаг поставить нельзя.
   */
  toggleFlag(row, col, expectedVersion) {
    const cell = this.getCell(row, col);
    if (!cell) return { ok: false, reason: 'out_of_bounds' };
    if (this.status !== 'playing') return { ok: false, reason: 'game_over' };

    // Та же проверка на конкурентный доступ.
    if (expectedVersion !== undefined && cell.version !== expectedVersion) {
      return { ok: false, reason: 'conflict', cell };
    }

    if (cell.state === 'revealed') return { ok: false, reason: 'revealed', cell };

    // Флаг ↔ скрыто: тумблер.
    cell.state = cell.state === 'flagged' ? 'hidden' : 'flagged';
    cell.version++; // ← версия растёт при любой мутации
    return { ok: true, changed: [cell], status: this.status };
  }

  // ==========================================================================
  // ВНУТРЕННИЕ ОПЕРАЦИИ НАД КЛЕТКАМИ
  // ==========================================================================

  /** Раскрыть одну клетку (идемпотентно: повторный вызов ничего не делает). */
  revealCell(cell, changed) {
    if (cell.state === 'revealed') return;
    cell.state = 'revealed';
    cell.version++;
    changed.push(cell);
  }

  /**
   * Каскадное раскрытие (алгоритм BFS).
   * Если клетка с adjacent === 0 — раскрываем всех её соседей.
   * Каскад останавливается на границе: мины, флаги, уже раскрытые.
   */
  revealCascade(start, changed) {
    const queue = [start];
    const seen = new Set();

    while (queue.length) {
      const cell = queue.shift();      // O(n) для shift — но поле ≤ 900 клеток
      if (seen.has(cell)) continue;    // защита от зацикливания
      seen.add(cell);

      if (cell.state === 'revealed') continue;
      if (cell.state === 'flagged') continue;  // флаг — не трогаем
      if (cell.mine) continue;                 // мину не раскрываем каскадом

      this.revealCell(cell, changed);

      // Только клетки с adjacent === 0 дают каскад.
      if (cell.adjacent === 0) {
        for (const n of this.neighbors(cell.row, cell.col)) {
          if (!seen.has(n)) queue.push(n);
        }
      }
    }
  }

  /**
   * Раскрыть все мины (при проигрыше или победе) + снять флаги
   * с не-минных клеток (классическое поведение сапёра).
   */
  revealAllMines(changed) {
    for (const cell of this.cells) {
      if (cell.mine && cell.state !== 'revealed') {
        cell.state = 'revealed';
        cell.version++;
        changed.push(cell);
      } else if (!cell.mine && cell.state === 'flagged') {
        // Флаг «стоял не на той клетке» — снимаем и показываем как обычную.
        cell.state = 'hidden';
        cell.version++;
        changed.push(cell);
      }
    }
  }

  /** Победа = все не-минные клетки раскрыты. */
  checkWin() {
    if (!this.cells.some(c => !c.mine && c.state !== 'revealed')) {
      this.status = 'won';
    }
  }

  // ==========================================================================
  // СЕРИАЛИЗАЦИЯ
  // ==========================================================================

  /**
   * Сериализация клетки ДЛЯ КЛИЕНТА.
   * Ключевая идея: если клетка не раскрыта — не отдаём adjacent/mine.
   * Иначе клиент мог бы через DevTools посмотреть всю карту и читерить.
   */
  cellForClient(cell) {
    const revealed = cell.state === 'revealed';
    const out = { row: cell.row, col: cell.col, state: cell.state, version: cell.version };
    if (revealed) {
      out.adjacent = cell.adjacent;
      out.mine = cell.mine;
    }
    return out;
  }

  /** Полный снимок состояния — используется при join/rejoin и gameOver. */
  snapshot() {
    return {
      rows: this.rows, cols: this.cols, mines: this.mines,
      status: this.status,
      cells: this.cells.map(c => this.cellForClient(c)),
    };
  }

  /**
   * Сериализация ДЛЯ ДИСКА. В отличие от snapshot() включает mine/adjacent
   * у ВСЕХ клеток — иначе после рестарта сервера нельзя восстановить карту.
   */
  toPersisted() {
    return {
      rows: this.rows, cols: this.cols, mines: this.mines,
      status: this.status, cells: this.cells,
    };
  }

  /**
   * Восстановление из диска БЕЗ вызова конструктора (а значит — без
   * перегенерации поля). Если бы мы сделали `new Game(...)`, generate()
   * сгенерировал бы НОВУЮ карту мин и стёр бы сохранённую игру.
   *
   * Object.create(Game.prototype) — создаёт объект с прототипом Game,
   * но без вызова constructor. Классический приём «hydration».
   */
  static fromPersisted(d) {
    const g = Object.create(Game.prototype);
    g.rows = d.rows; g.cols = d.cols; g.mines = d.mines;
    g.status = d.status; g.cells = d.cells;
    return g;
  }
}

module.exports = { Game };
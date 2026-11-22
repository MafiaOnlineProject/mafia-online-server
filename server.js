const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { run, get, all, initDb } = require('./db');
const { 
  startGame, 
  resetRoomToWaiting, 
  checkWinCondition, 
  advancePhaseIfExpired, 
  registerAction 
} = require('./gameEngine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

  const user = await get('SELECT id, username FROM users WHERE token = ?', [token]);
  if (!user) return res.status(401).json({ error: 'Недействительная сессия' });

  req.user = user;
  next();
}

//Регистрация
app.post('/api/auth/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    if (username.length < 2) {
      return res.status(400).json({ error: 'Слишком короткий логин'});
     } else if (password.length < 3) {
       return res.status(400).json({ error: 'Слишком короткий пароль'});
     }

    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: 'Это имя уже занято' });
    }

    const token = generateToken();
    const result = await run(
      'INSERT INTO users (username, password_hash, token) VALUES (?, ?, ?)',
      [username, hashPassword(password), token]
    );

    res.json({ token, user: { id: result.id, username } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// Авторизация
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const user = await get(
      'SELECT id, username, password_hash FROM users WHERE username = ?', 
      [username]
    );

    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = generateToken();
    await run('UPDATE users SET token = ? WHERE id = ?',[token, user.id]);

    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера при авторизации' });
  }
});

// Проверка сессии
app.get('/api/me', authMiddleware, async (req, res) => {
  const rooms = await all('SELECT * FROM rooms');
  let activeRoom = null;

  for (const r of rooms) {
    const state = JSON.parse(r.game_state);
    if (state.players.some((p) => p.id === req.user.id)) {
      activeRoom = { id: r.id, name: r.name, code: r.code, hostId: r.host_id, status: r.status, ...state};
      break;
    }
  }

  res.json({ user: req.user, activeRoom });
});

// Список комнат
app.get('/api/rooms', authMiddleware, async (req, res) => {
  const rows = await all("SELECT * FROM rooms WHERE status != 'FINISHED' ORDER BY id DESC");
  const rooms = rows.map((r) => {
    const state = JSON.parse(r.game_state);
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      status: r.status,
      playerCount: state.players.length
    };
  });

  res.json({ rooms });
});

// Создание комнаты
app.post('/api/rooms', authMiddleware, async (req, res) => {
  const name = (req.body.name || '').trim() || `Комната ${req.user.username}`;
  const code = generateRoomCode();
  const initialState = {
    phase: 'WAITING',
    dayNumber: 0,
    phaseEndsAt: null,
    lastAnnouncement: '',
    players: [{ id: req.user.id, username: req.user.username, role: null, isAlive: true }],
    nightActions: {},
    dayVotes: {}
  };

  const result = await run(
    'INSERT INTO rooms (name, code, host_id, status, game_state) VALUES (?, ?, ?, ?, ?)',
    [name, code, req.user.id, 'WAITING', JSON.stringify(initialState)]
  );

  res.json({
    rooms: {
      id: result.id,
      name,
      code,
      hostId: req.user.id,
      status: 'WAITING',
      ...initialState
    }
  });
});

// Вход в комнату
app.post('/api/rooms/:id/join', authMiddleware, async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });

  const state = JSON.parse(row.game_state);
  const alreadyIn = state.players.some((p) => p.id === req.user.id);

  if (!alreadyIn) {
    if (row.status !== 'WAITING') {
      return res.status(400).json({ error: 'Игра уже началась' });
    }
    if (state.players.length >= 12) {
      return res.status(400).json({ error: 'Комната заполнена (максимум 12 игроков)' });
    }
    state.players.push({ id: req.user.id, username: req.user.username, role: null, isAlive: true });
    await run('UPDATE rooms SET game_state = ? WHERE id = ?', [JSON.stringify(state), row.id]);
  }

  res.json({
    room: { 
      id: row.id, 
      name: row.name, 
      code: row.code, 
      hostId: row.host_id, 
      status: row.status, 
      ...state 
    }
  });
});

// Выход из комнаты
app.post('/api/rooms/:id/leave', authMiddleware, async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.json({ ok: true });

  const state = JSON.parse(row.game_state);
  const leavingPlayer = state.players.find((p) => p.id === req.user.id);
  state.players = state.players.filter((p) => p.id !== req.user.id);

  if (state.players.length === 0) {
    await run('DELETE FROM rooms WHERE id = ?', [row.id]);
    return res.json({ ok: true });
  }

  let newStatus = row.status;
  if (row.status === 'PLAYING' && leavingPlayer) {
    state.lastAnnouncement = `Игрок ${leavingPlayer.username} покинул игру.`;
    const winMessage = checkWinCondition(state.players);
    if (winMessage) {
      state.phase = 'GAME_OVER';
      state.phaseEndsAt = null;
      state.lastAnnouncement += ` ${winMessage}`;
      newStatus = 'FINISHED';
    }
  }

  const newHostId = row.host_id === req.user.id ? state.players[0].id : row.host_id;
  await run('UPDATE rooms SET host_id = ?, status = ?, game_state = ? WHERE id = ?', [
    newHostId,
    newStatus,
    JSON.stringify(state),
    row.id
  ]);

  res.json({ ok: true });
});

// Узнаём состояние комнаты
app.get('/api/rooms/:id', authMiddleware, async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната закрыта' });

  let state = JSON.parse(row.game_state);
  const check = advancePhaseIfExpired(state);
  if (check.changed) {
    state = check.state;
    const newStatus = state.phase === 'GAME_OVER' ? 'FINISHED' : row.status;
    await run('UPDATE rooms SET status = ?, game_state = ? WHERE id = ?', [
      newStatus,
      JSON.stringify(state),
      row.id
    ]);
    row.status = newStatus;
  }

  res.json({
    serverTime: Date.now(),
    room: { 
      id: row.id, 
      name: row.name, 
      code: row.code, 
      hostId: row.host_id, 
      status: row.status, 
      ...state 
    }
  });
});

// Старт игры (только хост)
app.post('/api/rooms/:id/start', authMiddleware, async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });
  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель может начать игру' });
  }

  let state = JSON.parse(row.game_state);
  if (state.players.length < 4) {
    return res.status(400).json({ error: 'Нужно минимум 4 игрока' });
  }

  state = startGame(state);
  await run('UPDATE rooms SET status = ?, game_state = ? WHERE id = ?', [
    'PLAYING',
    JSON.stringify(state),
    row.id
  ]);

  res.json({
    serverTime: Date.now(),
    room: { 
      id: row.id, 
      name: row.name, 
      code: row.code, 
      hostId: row.host_id, 
      status: 'PLAYING', 
      ...state 
    }
  });
});

// Перезапуск игры после завершения (только хост)
app.post('/api/rooms/:id/restart', authMiddleware, async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });
  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель может перезапустить игру' });
  }

  let state = JSON.parse(row.game_state);
  state = resetRoomToWaiting(state);

  await run('UPDATE rooms SET status = ?, game_state = ? WHERE id = ?', [
    'WAITING',
    JSON.stringify(state),
    row.id
  ]);

  res.json({
    room: { 
      id: row.id, 
      name: row.name, 
      code: row.code, 
      hostId: row.host_id, 
      status: 'WAITING', 
      ...state 
    }
  });
});

// Отправка ночного хода или дневного голоса
app.post('/api/rooms/:id/action', authMiddleware, async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });

  let state = JSON.parse(row.game_state);
  state = registerAction(state, req.user.id, Number(req.body.targetId));

  await run('UPDATE rooms SET game_state = ? WHERE id = ?', [JSON.stringify(state), row.id]);
  res.json({
    room: { 
      id: row.id, 
      name: row.name, 
      code: row.code, 
      hostId: row.host_id, 
      status: row.status, 
      ...state 
    }
  });
});

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер Mafia запущен на http://0.0.0.0:${PORT}`);
  });
});

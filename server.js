const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { run, get, all, initDb } = require('./db');
const { 
  BOT_NAMES,
  normalizeSettings,
  startGame, 
  resetRoomToWaiting, 
  checkWinCondition, 
  handlePlayerLeaveInPhase,
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

function sanitizeRoomForUser(row, state, userId) {
  const me = state.players.find((p) => p.id === userId);
  const amIMafia = me && (me.role === 'MAFIA' || me.role === 'MAFIA_BOSS');
  const isGameOver = state.phase === 'GAME_OVER';

  const safePlayers = state.players.map((p) => {
    const isMe = p.id === userId;
    const isFellowMafia = amIMafia && (p.role === 'MAFIA' || p.role === 'MAFIA_BOSS');
    const canSeeRole = isGameOver || !p.isAlive || isMe || isFellowMafia;

    return {
      id: p.id,
      username: p.username,
      isAlive: p.isAlive,
      isBot: Boolean(p.isBot),
      isLeft: Boolean(p.isLeft),
      role: canSeeRole ? p.role : null
    };
  });

  const safeDetectiveReport =
    state.detectiveReport && state.detectiveReport.detectiveId === userId
      ? state.detectiveReport
      : null;

  const safeNightActions = {
    MISTRESS: me?.role === 'MISTRESS' ? state.nightActions?.MISTRESS || null : null,
    DOCTOR: me?.role === 'DOCTOR' ? state.nightActions?.DOCTOR || null : null,
    MAFIA: amIMafia ? state.nightActions?.MAFIA || null : null,
    MANIAC: me?.role === 'MANIAC' ? state.nightActions?.MANIAC || null : null,
    DETECTIVE: me?.role === 'DETECTIVE' ? state.nightActions?.DETECTIVE || null : null
  };

  const revealVotes = state.phase === 'DAY_RESULTS' || state.phase === 'GAME_OVER';
  const myVote = state.dayVotes?.[userId];

  return {
    id: row.id,
    name: row.name,
    code: row.code,
    hostId: row.host_id,
    status: row.status,
    phase: state.phase,
    dayNumber: state.dayNumber,
    phaseEndsAt: state.phaseEndsAt,
    lastAnnouncement: state.lastAnnouncement,
    settings: normalizeSettings(state.settings),
    dayAlibiId: state.dayAlibiId || null,
    lastTargets: {
      MISTRESS: me?.role === 'MISTRESS' ? state.lastTargets?.MISTRESS || null : null,
      DOCTOR: me?.role === 'DOCTOR' ? state.lastTargets?.DOCTOR || null : null
    },
    players: safePlayers,
    nightActions: safeNightActions,
    dayVotes: revealVotes ? (state.dayVotes || {}) : (myVote ? { [userId]: myVote } : {}),
    detectiveReport: safeDetectiveReport
  };
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const roomLocks = new Map();
function withRoomLock(roomId, fn) {
  const key = String(roomId);
  const prev = roomLocks.get(key) || Promise.resolve();
  const result = prev.then(fn);
  const tail = result.catch(() => {});
  roomLocks.set(key, tail);
  tail.then(() => { if (roomLocks.get(key) === tail) roomLocks.delete(key); });
  return result;
}

const roomRoute = (fn) => ah((req, res) => withRoomLock(req.params.id, () => fn(req, res)));

const auth = ah(authMiddleware);

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
app.get('/api/me', auth, ah(async (req, res) => {
  const rows = await all("SELECT * FROM rooms ORDER BY id DESC");
  let activeRoom = null;

  for (const r of rows) {
    try {
      const state = JSON.parse(r.game_state);
      if (state.players.some((p) => p.id === req.user.id && !p.isLeft)) {
        activeRoom = sanitizeRoomForUser(r, state, req.user.id);
        break;
      }
    } catch {}
  }

  res.json({ serverTime: Date.now(), user: req.user, activeRoom });
}));

// Список комнат
app.get('/api/rooms', auth, ah(async (req, res) => {
  const rows = await all("SELECT * FROM rooms ORDER BY id DESC");
  const rooms = rows.map((r) => {
    const state = JSON.parse(r.game_state);
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      status: r.status,
      phase: state.phase,
      playerCount: state.players.filter((p) => !p.isLeft).length,
      maxPlayers: state.settings?.maxPlayers || 12
    };
  });

  res.json({ rooms });
}));

// Создание комнаты
app.post('/api/rooms', auth, ah(async (req, res) => {
  const rawName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const name = rawName.slice(0, 30) || `Комната ${req.user.username}`;
  const settings = normalizeSettings(req.body.settings);
  const code = generateRoomCode();
  const initialState = {
    phase: 'WAITING',
    dayNumber: 0,
    phaseEndsAt: null,
    lastAnnouncement: '',
    settings,
    players: [{ id: req.user.id, username: req.user.username, role: null, isAlive: true }],
    nightActions: {},
    dayVotes: {}
  };

  const result = await run(
    'INSERT INTO rooms (name, code, host_id, status, game_state) VALUES (?, ?, ?, ?, ?)',
    [name, code, req.user.id, 'WAITING', JSON.stringify(initialState)]
  );

  const row = {
    id: result.id,
    name,
    code,
    host_id: req.user.id,
    status: 'WAITING'
  };

  res.json({
    serverTime: Date.now(),
    room: sanitizeRoomForUser(row, initialState, req.user.id)
  });
}));

// Вход в комнату
app.post('/api/rooms/:id/join', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });

  const state = JSON.parse(row.game_state);
  const me = state.players.find((p) => p.id === req.user.id);

  if (me && !me.isLeft) {
    return res.json({ serverTime: Date.now(), room: sanitizeRoomForUser(row, state, req.user.id) });
  }
  if (row.status !== 'WAITING') {
    return res.status(400).json({ error: 'Игра уже началась' });
  }

  const maxPlayers = state.settings?.maxPlayers || 12;
  if (state.players.length >= maxPlayers) {
    return res.status(400).json({ error: `Комната заполнена (максимум ${maxPlayers} игроков)` });
  }

  state.players.push({ id: req.user.id, username: req.user.username, role: null, isAlive: true });
  await run(
    'UPDATE rooms SET game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
    [JSON.stringify(state), row.id]
  );

  res.json({ 
    serverTime: Date.now(),
    room: sanitizeRoomForUser(row, state, req.user.id) 
  });
}));

// Выход из комнаты
app.post('/api/rooms/:id/leave', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.json({ ok: true });

  let state = JSON.parse(row.game_state);
  const leavingPlayer = state.players.find((p) => p.id === req.user.id && !p.isLeft);
  if (!leavingPlayer) return res.json({ ok: true });

  if (row.status === 'WAITING') {
    state.players = state.players.filter((p) => p.id !== req.user.id);
  } else {
    leavingPlayer.isAlive = false;
    leavingPlayer.isLeft = true;
    delete state.dayVotes[leavingPlayer.id];

    if (state.phase !== 'GAME_OVER') {
      state.lastAnnouncement = `Игрок ${leavingPlayer.username} покинул игру.`;
      const winMessage = checkWinCondition(state.players);
      if (winMessage) {
        state.phase = 'GAME_OVER';
        state.phaseEndsAt = null;
        state.lastAnnouncement += ` ${winMessage}`;
      } else {
        state = handlePlayerLeaveInPhase(state, leavingPlayer);
      }
    }
  }

  const activeHumans = state.players.filter((p) => !p.isBot && !p.isLeft);
  if (activeHumans.length === 0) {
    await run('DELETE FROM rooms WHERE id = ?', [row.id]);
    return res.json({ ok: true });
  }

  const newHostId = row.host_id === leavingPlayer.id ? activeHumans[0].id : row.host_id;
  await run('UPDATE rooms SET host_id = ?, game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
    [newHostId, JSON.stringify(state), row.id]
  );

  res.json({ ok: true });
}));

// Узнаём состояние комнаты
app.get('/api/rooms/:id', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната закрыта' });

  let state = JSON.parse(row.game_state);
  const check = advancePhaseIfExpired(state);
  if (check.changed) {
    state = check.state;
    await run('UPDATE rooms SET game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      JSON.stringify(state),
      row.id
    ]);
  }

  res.json({
    serverTime: Date.now(),
    room: sanitizeRoomForUser(row, state, req.user.id)
  });
}));

// Добавление бота в комнату ожидания (только хост)
app.post('/api/rooms/:id/add-bot', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });
  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель может добавлять ботов' });
  }
  if (row.status !== 'WAITING') {
    return res.status(400).json({ error: 'Игра уже началась' });
  }

  const state = JSON.parse(row.game_state);
  const maxPlayers = state.settings?.maxPlayers || 12;
  if (state.players.length >= maxPlayers) {
    return res.status(400).json({ error: `Комната заполнена (максимум ${maxPlayers} игроков)` });
  }

  const usedNames = new Set(state.players.map((p) => p.username));
  const freeName =
    BOT_NAMES.find((name) => !usedNames.has(name)) || `Бот #${state.players.length + 1}`;

  
  const minBotId = state.players.reduce((min, p) => (p.id < min ? p.id : min), 0);
  const botId = minBotId - 1;

  state.players.push({
    id: botId,
    username: freeName,
    role: null,
    isAlive: true,
    isBot: true
  });

  await run('UPDATE rooms SET game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(state), row.id]);

  res.json({ room: sanitizeRoomForUser(row, state, req.user.id) });
}));

// Исключение игрока или бота хостом (только в комнате ожидания)
app.post('/api/rooms/:id/kick', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });

  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель комнаты может исключать игроков' });
  }

  if (row.status !== 'WAITING') {
    return res.status(400).json({ error: 'Нельзя исключать игроков после начала игры' });
  }

  const targetId = Number(req.body.targetId);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Нельзя исключить самого себя' });
  }

  const state = JSON.parse(row.game_state);
  const exists = state.players.some((p) => p.id === targetId);
  if (!exists) {
    return res.status(404).json({ error: 'Игрок не найден в комнате' });
  }

  state.players = state.players.filter((p) => p.id !== targetId);

  await run(
    'UPDATE rooms SET game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(state), row.id]
  );

  res.json({
    serverTime: Date.now(),
    room: sanitizeRoomForUser(row, state, req.user.id)
  });
}));

// Обновление настроек комнаты хостом (только в комнате ожидания)
app.patch('/api/rooms/:id/settings', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });

  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель может менять настройки комнаты' });
  }

  if (row.status !== 'WAITING') {
    return res.status(400).json({ error: 'Нельзя менять настройки во время игры' });
  }

  const state = JSON.parse(row.game_state);
  const newSettings = normalizeSettings({ ...state.settings, ...(req.body.settings || {}) });

  if (state.players.length > newSettings.maxPlayers) {
    return res.status(400).json({
      error: `В комнате уже ${state.players.length} игроков — сначала исключите лишних или выберите больший размер`
    });
  }

  const rawName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const newName = rawName.slice(0, 30) || row.name;
  state.settings = newSettings;

  await run(
    'UPDATE rooms SET name = ?, game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [newName, JSON.stringify(state), row.id]
  );

  res.json({
    serverTime: Date.now(),
    room: sanitizeRoomForUser({ ...row, name: newName }, state, req.user.id)
  });
}));

// Старт игры (только хост)
app.post('/api/rooms/:id/start', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });
  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель может начать игру' });
  }

  if (row.status !== 'WAITING') {
    return res.status(400).json({ error: 'Игра уже запущена' });
  }

  let state = JSON.parse(row.game_state);
  if (state.players.length < 4) {
    return res.status(400).json({ error: 'Нужно минимум 4 игрока' });
  }

  state = startGame(state);
  await run('UPDATE rooms SET status = ?, game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    'PLAYING',
    JSON.stringify(state),
    row.id
  ]);

  res.json({
    serverTime: Date.now(),
    room: sanitizeRoomForUser({ ...row, status: 'PLAYING' }, state, req.user.id)
  });
}));

// Перезапуск игры после завершения (только хост)
app.post('/api/rooms/:id/restart', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });
  if (row.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Только создатель может перезапустить игру' });
  }

  let state = JSON.parse(row.game_state);
  if (state.phase !== 'GAME_OVER') {
    return res.status(400).json({ error: 'Нельзя перезапустить игру до её завершения' });
  }
  state = resetRoomToWaiting(state);

  await run('UPDATE rooms SET status = ?, game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    'WAITING',
    JSON.stringify(state),
    row.id
  ]);

  res.json({ room: sanitizeRoomForUser({ ...row, status: 'WAITING' }, state, req.user.id) });
}));

// Отправка ночного хода или дневного голоса
app.post('/api/rooms/:id/action', auth, roomRoute(async (req, res) => {
  const row = await get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Комната не найдена' });

  let state = JSON.parse(row.game_state);
  if (row.status !== 'PLAYING' || state.phase === 'WAITING' || state.phase === 'GAME_OVER') {
    return res.status(400).json({ error: 'Сейчас нельзя совершать игровые действия' });
  }

  const phaseCheck = advancePhaseIfExpired(state);
  let currentState = phaseCheck.state;
  let accepted = false;
  let errorMsg = '';

  if (phaseCheck.advanced) {
    errorMsg = 'Фаза уже сменилась';
  } else {
    const actionRes = registerAction(currentState, req.user.id, Number(req.body.targetId));
    currentState = actionRes.state;
    accepted = actionRes.accepted;
    if (!accepted) {
      errorMsg = 'Недопустимое действие или цель для текущей фазы';
    }
  }

  if (phaseCheck.changed || accepted) {
    await run(
      'UPDATE rooms SET game_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [JSON.stringify(currentState), row.id]
    );
  }

  const payload = { 
    serverTime: Date.now(), 
    room: sanitizeRoomForUser(row, currentState, req.user.id) 
  };

  if (!accepted) {
    return res.status(400).json({
      error: errorMsg,
      ...payload
    });
  }

  res.json(payload);
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' });
});

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер Mafia запущен на http://0.0.0.0:${PORT}`);
  });

  setInterval(async () => {
    try {
      const stale = await all("SELECT id FROM rooms WHERE datetime(updated_at) < datetime('now','-30 minutes')");
      for (const { id } of stale) {
        await withRoomLock(id, () =>
          run("DELETE FROM rooms WHERE id = ? AND datetime(updated_at) < datetime('now','-30 minutes')", [id]));
      }
    } catch (e) { console.error(e); }
  }, 5 * 60 * 1000);
});

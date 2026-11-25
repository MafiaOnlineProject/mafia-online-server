const NIGHT_ROLES_ORDER = [
  {
    phase: 'NIGHT_MISTRESS',
    actionKey: 'MISTRESS',
    roles: ['MISTRESS'],
    getBotTargets: (alive, actor, state) =>
      alive.filter((p) => p.id !== actor.id && p.id !== state.lastTargets?.MISTRESS)
  },
  {
    phase: 'NIGHT_DOCTOR',
    actionKey: 'DOCTOR',
    roles: ['DOCTOR'],
    getBotTargets: (alive, actor, state) =>
      alive.filter((p) => p.id !== state.lastTargets?.DOCTOR)
  },
  {
    phase: 'NIGHT_MAFIA',
    actionKey: 'MAFIA',
    roles: ['MAFIA_BOSS', 'MAFIA'],
    getBotTargets: (alive) => alive.filter((p) => !isMafiaTeam(p.role))
  },
  {
    phase: 'NIGHT_MANIAC',
    actionKey: 'MANIAC',
    roles: ['MANIAC'],
    getBotTargets: (alive, actor) => alive.filter((p) => p.id !== actor.id)
  },
  {
    phase: 'NIGHT_DETECTIVE',
    actionKey: 'DETECTIVE',
    roles: ['DETECTIVE'],
    getBotTargets: (alive, actor) => alive.filter((p) => p.id !== actor.id)
  }
];

const BOT_NAMES = [
  'Бот Виктор',
  'Бот Анна',
  'Бот Марк',
  'Бот Соня',
  'Бот Артур',
  'Бот Елена',
  'Бот Денис',
  'Бот Кира',
  'Бот Павел',
  'Бот Ольга',
  'Бот Тимур',
  'Бот Алиса',
  'Бот Роман',
  'Бот Дарья',
  'Бот Игорь'
];

const ALLOWED_MAX_PLAYERS = [6, 8, 10, 12, 16];
const ALLOWED_DAY_DURATIONS = [60, 90, 120, 150];
const ALLOWED_NIGHT_DURATIONS = [20, 30, 45, 60];

function normalizeSettings(raw = {}) {
  const maxPlayers = ALLOWED_MAX_PLAYERS.includes(Number(raw.maxPlayers))
    ? Number(raw.maxPlayers)
    : 12;
  const dayDurationSec = ALLOWED_DAY_DURATIONS.includes(Number(raw.dayDurationSec))
    ? Number(raw.dayDurationSec)
    : 90;
  const nightDurationSec = ALLOWED_NIGHT_DURATIONS.includes(Number(raw.nightDurationSec))
    ? Number(raw.nightDurationSec)
    : 45;

  return {
    maxPlayers,
    dayDurationSec,
    nightDurationSec,
    enableMistress: raw.enableMistress !== false,
    enableManiac: raw.enableManiac !== false
  };
}

const MAX_LOG = 100;

function pushLog(state, text, { type = 'info', channel = 'public', visibleTo = null } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return state;
  if (!Array.isArray(state.log)) state.log = [];
  state.logSeq = (state.logSeq || 0) + 1;
  state.log.push({
    id: state.logSeq,
    at: Date.now(),
    day: state.dayNumber || 0,
    kind: 'system',
    type,
    channel,
    visibleTo,
    authorId: null,
    text: clean
  });
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
  return state;
}

function logNightAction(state, actor, target) {
  const t = target.username;
  switch (state.phase) {
    case 'NIGHT_MISTRESS':
      pushLog(state, `Вы отправились в гости к игроку ${t}.`, { type: 'action', visibleTo: actor.id });
      break;
    case 'NIGHT_DOCTOR':
      pushLog(state, actor.id === target.id ? 'Вы решили лечить себя.' : `Вы решили лечить игрока ${t}.`,
        { type: 'action', visibleTo: actor.id });
      break;
    case 'NIGHT_MAFIA':
      pushLog(state, `Мафия выбрала жертву: ${t}.`, { type: 'mafia', channel: 'mafia' });
      break;
    case 'NIGHT_MANIAC':
      pushLog(state, `Вы выбрали жертву: ${t}.`, { type: 'action', visibleTo: actor.id });
      break;
    case 'NIGHT_DETECTIVE':
      pushLog(state, `Вы проверяете игрока ${t}. Результат будет утром.`, { type: 'action', visibleTo: actor.id });
      break;
  }
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function assignRoles(players, rawSettings = {}) {
  const settings = normalizeSettings(rawSettings);
  const count = players.length;
  const rolesPool = ['MAFIA', 'DOCTOR', 'DETECTIVE'];

  if (count >= 8) {
    rolesPool.push('MAFIA_BOSS');
    if (settings.enableMistress) {
      rolesPool.push('MISTRESS');
    }
  }

  if (count >= 12) {
    if (settings.enableManiac) {
      rolesPool.push('MANIAC');
    } else {
      rolesPool.push('MAFIA'); // Если Маньяк выключен при 12+, добавляем 3-ю Мафию
    }
  }

  if (count >= 15) rolesPool.push('MAFIA');

  while (rolesPool.length < count) {
    rolesPool.push('CIVILIAN');
  }

  const shuffledRoles = shuffle(rolesPool);
  return players.map((player, idx) => ({
    ...player,
    role: shuffledRoles[idx],
    isAlive: true
  }));
}

function getNightStep(phase) {
  return NIGHT_ROLES_ORDER.find((step) => step.phase === phase) || null;
}

function getActiveNightActor(state) {
  const alive = state.players.filter((p) => p.isAlive);
  if (state.phase === 'NIGHT_MAFIA') return getActiveMafiaShooter(alive);
  const step = getNightStep(state.phase);
  return step ? alive.find((p) => step.roles.includes(p.role)) || null : null;
}

function getNextNightPhase(players, startFromIndex = 0) {
  for (let i = startFromIndex; i < NIGHT_ROLES_ORDER.length; i++) {
    const step = NIGHT_ROLES_ORDER[i];
    const hasAliveActor = players.some((p) => p.isAlive && step.roles.includes(p.role));
    if (hasAliveActor) {
      return step.phase;
    }
  }
  return null;
}

function isMafiaTeam(role) {
  return role === 'MAFIA_BOSS' || role === 'MAFIA';
}

function getActiveMafiaShooter(players) {
  const boss = players.find((p) => p.isAlive && p.role === 'MAFIA_BOSS');
  if (boss) return boss;
  return players.find((p) => p.isAlive && p.role === 'MAFIA') || null;
}

function checkWinCondition(players) {
  const alive = players.filter((p) => p.isAlive);
  const mafiaCount = alive.filter((p) => isMafiaTeam(p.role)).length;
  const maniacCount = alive.filter((p) => p.role === 'MANIAC').length;

  if (alive.length === 2 && mafiaCount === 1 && maniacCount === 1) {
    return 'Ничья! Последний мафиози и Маньяк остались один на один и уничтожили друг друга.';
  }
  if (maniacCount > 0 && mafiaCount === 0 && alive.length <= 2) {
    return 'Победа Маньяка! Он перехитрил весь город и остался последним.';
  }
  if (mafiaCount === 0 && maniacCount === 0) {
    return 'Победа мирных жителей! Все преступники обезврежены.';
  }
  if (mafiaCount >= alive.length - mafiaCount) {
    return 'Победа Мафии! Город полностью захвачен.';
  }
  return null;
}

function randomItem(arr) {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function performBotActions(state) {
  const alive = state.players.filter((p) => p.isAlive);

  const step = getNightStep(state.phase);
  if (step) {
    const actor = getActiveNightActor(state);
    if (actor?.isBot && !state.nightActions[step.actionKey]) {
      const choice = randomItem(step.getBotTargets(alive, actor, state));
      if (choice) {
        state.nightActions[step.actionKey] = choice.id;
        logNightAction(state, actor, choice);
      }
    }
    return state;
  } else if (state.phase === 'DAY_VOTING') {
    alive
      .filter((p) => p.isBot && !state.dayVotes[p.id])
      .forEach((bot) => {
        const isBotMafia = bot.role === 'MAFIA' || bot.role === 'MAFIA_BOSS';
        const targets = alive.filter((p) => {
          if (p.id === bot.id || p.id === state.dayAlibiId) return false;
          if (isBotMafia && (p.role === 'MAFIA' || p.role === 'MAFIA_BOSS')) return false;
          return true;
        });
        if (!targets.length) return;

        const validIds = new Set(targets.map((p) => p.id));
        const existingVotes = Object.values(state.dayVotes).filter((id) => validIds.has(id));

        let targetId = null;
        if (existingVotes.length > 0 && Math.random() < 0.7) {
          targetId = randomItem(existingVotes);
        } else {
          targetId = randomItem(targets)?.id;
        }

        if (targetId) state.dayVotes[bot.id] = targetId;
      });
  }

  return state;
}

function isPhaseReadyToAdvance(state) {
  if (state.phase === 'DAY_VOTING') {
    return state.players.filter((p) => p.isAlive).every((p) => Boolean(state.dayVotes[p.id]));
  }
  const step = getNightStep(state.phase);
  return step ? Boolean(state.nightActions[step.actionKey]) : false;
}

function handlePlayerLeaveInPhase(state, leftPlayer) {
  state = performBotActions(state);

  const alive = state.players.filter((p) => p.isAlive);
  const noActiveActorLeft =
    (state.phase === 'NIGHT_MISTRESS' && !alive.some((p) => p.role === 'MISTRESS')) ||
    (state.phase === 'NIGHT_DOCTOR' && !alive.some((p) => p.role === 'DOCTOR')) ||
    (state.phase === 'NIGHT_MAFIA' && !getActiveMafiaShooter(alive)) ||
    (state.phase === 'NIGHT_MANIAC' && !alive.some((p) => p.role === 'MANIAC')) ||
    (state.phase === 'NIGHT_DETECTIVE' && !alive.some((p) => p.role === 'DETECTIVE'));

  if ((noActiveActorLeft || isPhaseReadyToAdvance(state)) && state.phaseEndsAt && state.phaseEndsAt - Date.now() > 3000) {
    state.phaseEndsAt = Date.now() + 3000;
  }

  return state;
}

function isCurrentNightActorBot(state) {
  return Boolean(getActiveNightActor(state)?.isBot);
}

function getPhaseDurationMs(state) {
  const settings = normalizeSettings(state.settings);
  if (state.phase === 'DAY_VOTING') return settings.dayDurationSec * 1000; 
  return isCurrentNightActorBot(state) ? 4000 : settings.nightDurationSec * 1000;
}

function startGame(state) {
  const settings = normalizeSettings(state.settings);
  const updatedPlayers = assignRoles(state.players, settings);
  const firstPhase = getNextNightPhase(updatedPlayers, 0) || 'DAY_VOTING';

  let nextState = {
    ...state,
    phase: firstPhase,
    dayNumber: 1,
    phaseEndsAt: null,
    lastAnnouncement: '',
    players: updatedPlayers,
    nightActions: {},
    dayVotes: {},
    dayAlibiId: null,
    lastTargets: { MISTRESS: null, DOCTOR: null },
    detectiveReport: null,
    log: [],
    logSeq: 0
  };

  pushLog(nextState, 'Игра началась. Роли розданы.', { type: 'start' });
  nextState = performBotActions(nextState);
  nextState.phaseEndsAt = Date.now() + getPhaseDurationMs(nextState);
  return nextState;
}

function resolveNight(state) {
  const {
    MISTRESS: mistressTargetId,
    DOCTOR: healedId,
    MAFIA: killedId,
    MANIAC: maniacKilledId,
    DETECTIVE: checkedId
  } = state.nightActions;

  let updatedPlayers = state.players.map((p) => ({ ...p }));
  const doctor = updatedPlayers.find((p) => p.role === 'DOCTOR' && p.isAlive);
  const detective = updatedPlayers.find((p) => p.role === 'DETECTIVE' && p.isAlive);
  const maniac = updatedPlayers.find((p) => p.role === 'MANIAC' && p.isAlive);
  const shooter = getActiveMafiaShooter(updatedPlayers);

  // Любовница блокирует способность своей цели на эту ночь
  const isDoctorBlocked = doctor && mistressTargetId === doctor.id;
  const isDetectiveBlocked = detective && mistressTargetId === detective.id;
  const isMafiaBlocked = shooter && mistressTargetId === shooter.id;
  const isManiacBlocked = maniac && mistressTargetId === maniac.id;

  const effectiveHealedId = isDoctorBlocked ? null : healedId;
  const effectiveMafiaKill = isMafiaBlocked ? null : killedId;
  const effectiveManiacKill = isManiacBlocked ? null : maniacKilledId;
  const effectiveCheckedId = isDetectiveBlocked ? null : checkedId;

  let announcement = 'Наступило утро. ';
  let dayAlibiId = null;

  if (mistressTargetId) {
    const visited = updatedPlayers.find((p) => p.id === mistressTargetId);
    if (visited) {
      dayAlibiId = visited.id;
      announcement += `Любовница провела ночь у игрока ${visited.username} (у него алиби на дневном голосовании). `;
    }
  }

  const attackTargets = new Set();
  if (effectiveMafiaKill) attackTargets.add(effectiveMafiaKill);
  if (effectiveManiacKill) attackTargets.add(effectiveManiacKill);

  const killedNames = [];
  let someoneSavedByDoctor = false;

  attackTargets.forEach((targetId) => {
    if (targetId === effectiveHealedId) {
      someoneSavedByDoctor = true;
      return;
    }
    const victim = updatedPlayers.find((p) => p.id === targetId && p.isAlive);
    if (victim) {
      victim.isAlive = false;
      killedNames.push(victim.username);
      if (victim.id === dayAlibiId) dayAlibiId = null;
    }
  });

  if (killedNames.length > 0) {
    if (killedNames.length === 1) {
      announcement += `Этой ночью погиб: ${killedNames[0]}. `;
    } else {
      announcement += `Этой ночью погибли: ${killedNames.join(', ')}. `;
    }
  } 
  if (someoneSavedByDoctor) {
    if (killedNames.length === 0) {
      announcement += 'Доктор вовремя спас жертву. Никто не погиб.';
    } else {
      announcement += 'Доктор вовремя спас одну из жертв.';
    }
  } 
  if (killedNames.length === 0 && !someoneSavedByDoctor) {
    announcement += 'Ночь прошла спокойно, никто не пострадал.';
  }

  let detectiveReport = null;
  if (detective) {
    if (isDetectiveBlocked) {
      detectiveReport = {
        detectiveId: detective.id,
        message: 'Вас отвлекла Любовница. Вы не смогли провести проверку этой ночью.'
      };
    } else if (effectiveCheckedId) {
      const target = updatedPlayers.find((p) => p.id === effectiveCheckedId);
      if (target) {
        const statusLabel = isMafiaTeam(target.role)
          ? 'МАФИЯ!'
          : target.role === 'MANIAC'
            ? 'МАНЬЯК!'
            : 'мирный житель.';
        detectiveReport = {
          detectiveId: detective.id,
          message: `Результат проверки: игрок ${target.username} — ${statusLabel}`
        };
      }
    }
  }

  if (detectiveReport) {
    pushLog(state, '🔍 ' + detectiveReport.message, { type: 'private', visibleTo: detectiveReport.detectiveId });
  }

  const updatedLastTargets = {
    MISTRESS: mistressTargetId || null,
    DOCTOR: effectiveHealedId || null
  };

  const winMessage = checkWinCondition(updatedPlayers);
  pushLog(state, announcement, { type: 'night' });
  if (winMessage) pushLog(state, winMessage, { type: 'end' });
  if (winMessage) {
    return {
      ...state,
      phase: 'GAME_OVER',
      phaseEndsAt: null,
      lastAnnouncement: `${winMessage}`,
      players: updatedPlayers,
      nightActions: {},
      dayVotes: {},
      dayAlibiId: null,
      lastTargets: updatedLastTargets,
      detectiveReport
    };
  }

  const settings = normalizeSettings(state.settings);

  let dayState = {
    ...state,
    phase: 'DAY_VOTING',
    phaseEndsAt: Date.now() + settings.dayDurationSec * 1000,
    players: updatedPlayers,
    nightActions: {},
    dayVotes: {},
    dayAlibiId,
    lastTargets: updatedLastTargets,
    detectiveReport
  };

  dayState = performBotActions(dayState);
  if (isPhaseReadyToAdvance(dayState)) {
    dayState.phaseEndsAt = Date.now() + 3000;
  }

  return dayState;
}

function resolveDay(state) {
  const aliveIds = new Set(state.players.filter((p) => p.isAlive).map((p) => p.id));
  const tally = {};
  Object.values(state.dayVotes)
  .filter((targetId) => aliveIds.has(targetId))
  .forEach((targetId) => {
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let candidateId = null;
  let isTie = false;

  Object.entries(tally).forEach(([targetIdStr, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      candidateId = Number(targetIdStr);
      isTie = false;
    } else if (count === maxVotes && count > 0) {
      isTie = true;
    }
  });

  let updatedPlayers = state.players.map((p) => ({ ...p }));
  let announcement = '';

  if (!candidateId || isTie) {
    announcement = 'Голоса разделились поровну (или никто не проголосовал). Никто не покидает город.';
  } else {
    const exiled = updatedPlayers.find((p) => p.id === candidateId);
    if (exiled) {
      exiled.isAlive = false;
      announcement = `По итогам голосования город покидает ${exiled.username} ({{ROLE:${exiled.role}}}).`;
    }
  }

  const winMessage = checkWinCondition(updatedPlayers);
  pushLog(state, announcement, { type: 'vote' });
  if (winMessage) pushLog(state, winMessage, { type: 'end' });
  if (winMessage) {
    return {
      ...state,
      phase: 'GAME_OVER',
      phaseEndsAt: null,
      lastAnnouncement: `${winMessage}`,
      players: updatedPlayers,
      nightActions: {},
      dayAlibiId: null,
      detectiveReport: null
    };
  }

  return {
    ...state,
    phase: 'DAY_RESULTS',
    phaseEndsAt: Date.now() + 5000,
    players: updatedPlayers,
    nightActions: {},
    dayAlibiId: null,
    detectiveReport: null
  };
}

function startNextNightFromDayResults(state) {
  const nextNightPhase = getNextNightPhase(state.players, 0) || 'DAY_VOTING';

  const firstRoleMap = {
    NIGHT_MISTRESS: 'Просыпается Любовница и делает свой выбор...',
    NIGHT_DOCTOR: 'Просыпается Доктор и решает, кого спасти...',
    NIGHT_MAFIA: 'Просыпается Мафия и выходит на охоту...',
    NIGHT_MANIAC: 'На охоту выходит Маньяк...',
    NIGHT_DETECTIVE: 'Просыпается Детектив и ищет преступников...'
  };
  const firstRoleLabel = firstRoleMap[nextNightPhase] || 'Город засыпает...';

  let nextState = {
    ...state,
    phase: nextNightPhase,
    dayNumber: (state.dayNumber || 1) + 1,
    phaseEndsAt: null,
    lastAnnouncement: `Наступает ночь. ${firstRoleLabel}`,
    players: state.players,
    nightActions: {},
    dayVotes: {},
    dayAlibiId: null,
    detectiveReport: null
  };

  nextState = performBotActions(nextState);
  nextState.phaseEndsAt = Date.now() + getPhaseDurationMs(nextState);
  return nextState;
}

function advancePhaseIfExpired(state) {
  let changed = false;

  const prevCount =
    Object.keys(state.nightActions || {}).length + Object.keys(state.dayVotes || {}).length;
  state = performBotActions(state);

  if (
    state.phaseEndsAt &&
    isPhaseReadyToAdvance(state) &&
    state.phaseEndsAt - Date.now() > 3000
  ) {
    state.phaseEndsAt = Date.now() + 3000;
    changed = true;
  }

  const nextCount =
    Object.keys(state.nightActions || {}).length + Object.keys(state.dayVotes || {}).length;
  if (nextCount !== prevCount) {
    changed = true;
  }

  if (!state.phaseEndsAt || Date.now() < state.phaseEndsAt) {
    return { state, changed, advanced: false };
  }

  const currentIdx = NIGHT_ROLES_ORDER.findIndex((step) => step.phase === state.phase);
  if (currentIdx !== -1) {
    const nextPhase = getNextNightPhase(state.players, currentIdx + 1);
    if (nextPhase) {
      let nextState = {
        ...state,
        phase: nextPhase,
        phaseEndsAt: null,
        lastAnnouncement: ''
      };
      nextState = performBotActions(nextState);
      nextState.phaseEndsAt = Date.now() + getPhaseDurationMs(nextState);
      return { changed: true, advanced: true, state: nextState };
    }
    return { changed: true, advanced: true, state: resolveNight(state) };
  }

  if (state.phase === 'DAY_VOTING') {
    return { changed: true, advanced: true, state: resolveDay(state) };
  }

  if (state.phase === 'DAY_RESULTS') {
    return { changed: true, advanced: true, state: startNextNightFromDayResults(state) };
  }

  return { state, changed, advanced: false };
}

function registerAction(state, userId, targetId) {
  const actor = state.players.find((p) => p.id === userId && p.isAlive);
  if (!actor) return { state, accepted: false };

  const target = state.players.find((p) => p.id === targetId && p.isAlive);
  if (!target) return { state, accepted: false };

  if (state.phase !== 'NIGHT_DOCTOR' && userId === targetId) {
    return { state, accepted: false };
  }

  let accepted = false;

  if (state.phase === 'NIGHT_MISTRESS' && actor.role === 'MISTRESS') {
    if (!state.nightActions.MISTRESS && state.lastTargets?.MISTRESS !== targetId) {
      state.nightActions.MISTRESS = targetId;
      accepted = true;
    }
  } else if (state.phase === 'NIGHT_DOCTOR' && actor.role === 'DOCTOR') {
    if (!state.nightActions.DOCTOR && state.lastTargets?.DOCTOR !== targetId) {
      state.nightActions.DOCTOR = targetId;
      accepted = true;
    }
  } else if (state.phase === 'NIGHT_MAFIA') {
    const shooter = getActiveMafiaShooter(state.players);
    if (!state.nightActions.MAFIA && shooter && shooter.id === userId && !isMafiaTeam(target.role)) {
      state.nightActions.MAFIA = targetId;
      accepted = true;
    }
  } else if (state.phase === 'NIGHT_MANIAC' && actor.role === 'MANIAC') {
    if (!state.nightActions.MANIAC) {
      state.nightActions.MANIAC = targetId;
      accepted = true;
    }
  } else if (state.phase === 'NIGHT_DETECTIVE' && actor.role === 'DETECTIVE') {
    if (!state.nightActions.DETECTIVE) {
      state.nightActions.DETECTIVE = targetId;
      accepted = true;
    }
  } else if (state.phase === 'DAY_VOTING') {
    if (!state.dayVotes[userId] && state.dayAlibiId !== targetId) {
      state.dayVotes[userId] = targetId;
      accepted = true;
    }
  }

  if (accepted && state.phaseEndsAt && isPhaseReadyToAdvance(state) && state.phaseEndsAt - Date.now() > 3000) {
    state.phaseEndsAt = Date.now() + 3000;
  }

  if (accepted && state.phase !== 'DAY_VOTING') {
    logNightAction(state, actor, target);
  }

  return { state, accepted };
}

function resetRoomToWaiting(state) {
  return {
    ...state,
    phase: 'WAITING',
    dayNumber: 0,
    phaseEndsAt: null,
    lastAnnouncement: '',
    settings: normalizeSettings(state.settings),
    players: state.players
      .filter((p) => !p.isLeft)
      .map((p) => ({
        id: p.id,
        username: p.username,
        role: null,
        isAlive: true,
        isBot: Boolean(p.isBot)
    })),
    nightActions: {},
    dayVotes: {},
    lastTargets: { MISTRESS: null, DOCTOR: null },
    detectiveReport: null,
    log: [],
    logSeq: 0
  };
}

module.exports = { 
  BOT_NAMES,
  normalizeSettings,
  isMafiaTeam, 
  checkWinCondition, 
  startGame, 
  handlePlayerLeaveInPhase,
  advancePhaseIfExpired, 
  registerAction,
  resetRoomToWaiting,
  pushLog
};
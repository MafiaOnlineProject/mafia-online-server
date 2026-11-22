const NIGHT_DURATION_MS = 45 * 1000; //Время для каджой ночной роли
const DAY_DURATION_MS = 90 * 1000; //Время на девное обсуждение и голосование
//Позже можно добавить возможность выставлять время самому хосту комнаты

const NIGHT_ROLES_ORDER = [
  { phase: 'NIGHT_MISTRESS', roles: ['MISTRESS'] },
  { phase: 'NIGHT_DOCTOR', roles: ['DOCTOR'] },
  { phase: 'NIGHT_MAFIA', roles: ['MAFIA_BOSS', 'MAFIA'] },
  { phase: 'NIGHT_DETECTIVE', roles: ['DETECTIVE'] }
];

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function assignRoles(players) {
  const count = players.length;
  const rolesPool = ['MAFIA', 'DOCTOR', 'DETECTIVE'];

  //Если игроков больше 8, добавляем вторую мафию
  if (count >= 8) {
    rolesPool.push('MAFIA_BOSS', 'MISTRESS');
  }

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
  const townCount = alive.length - mafiaCount;

  if (mafiaCount === 0) {
    return 'Победа мирных жителей! Вся мафия обезврежена.';
  }
  if (mafiaCount >= townCount) {
    return 'Победа Мафии! Город полностью захвачен.';
  }
  return null;
}

function startGame(state) {
  const updatedPlayers = assignRoles(state.players);
  const firstPhase = getNextNightPhase(updatedPlayers, 0) || 'DAY_VOTING';

  return {
    ...state,
    phase: firstPhase,
    dayNumber: 1,
    phaseEndsAt: Date.now() + NIGHT_DURATION_MS,
    lastAnnouncement: 'Город засыпает. Начинается первая ночь...',
    players: updatedPlayers,
    nightActions: {},
    dayVotes: {},
    lastTargets: { MISTRESS: null, DOCTOR: null },
    detectiveReport: null
  };
}

function resolveNight(state) {
  const {
    MISTRESS: mistressTargetId,
    DOCTOR: healedId,
    MAFIA: killedId,
    DETECTIVE: checkedId
  } = state.nightActions;

  let updatedPlayers = state.players.map((p) => ({ ...p }));
  const doctor = updatedPlayers.find((p) => p.role === 'DOCTOR' && p.isAlive);
  const detective = updatedPlayers.find((p) => p.role === 'DETECTIVE' && p.isAlive);
  const shooter = getActiveMafiaShooter(updatedPlayers);

  // Любовница блокирует способность своей цели на эту ночь
  const isDoctorBlocked = doctor && mistressTargetId === doctor.id;
  const isDetectiveBlocked = detective && mistressTargetId === detective.id;
  const isMafiaBlocked = shooter && mistressTargetId === shooter.id;

  const effectiveHealedId = isDoctorBlocked ? null : healedId;
  const effectiveKilledId = isMafiaBlocked ? null : killedId;
  const effectiveCheckedId = isDetectiveBlocked ? null : checkedId;

  const savedByDoctor = effectiveKilledId && effectiveKilledId === effectiveHealedId;

  let announcement = 'Наступило утро. ';
  let dayAlibiId = null;

  if (mistressTargetId) {
    const visited = updatedPlayers.find((p) => p.id === mistressTargetId);
    if (visited) {
      announcement += `Любовница провела ночь у игрока ${visited.username} (у него алиби на дневном голосовании). `;
    }
  }

  if (effectiveKilledId && !savedByDoctor) {
    const victim = updatedPlayers.find((p) => p.id === effectiveKilledId);
    if (victim) {
      victim.isAlive = false;
      announcement += `Этой ночью был убит игрок ${victim.username}.`;
      if (victim.id === dayAlibiId) dayAlibiId = null;
    }
  } else if (savedByDoctor) {
    announcement += 'Мафия выходила на охоту, но Доктор вовремя спас жертву. Никто не погиб.';
  } else {
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
        detectiveReport = {
          detectiveId: detective.id,
          message: `Результат проверки: игрок ${target.username} — ${isMafiaTeam(target.role) ? 'МАФИЯ!' : 'не мафия.'}`
        };
      }
    }
  }

  const updatedLastTargets = {
    MISTRESS: mistressTargetId || null,
    DOCTOR: effectiveHealedId || null
  };

  const winMessage = checkWinCondition(updatedPlayers);
  if (winMessage) {
    return {
      ...state,
      phase: 'GAME_OVER',
      phaseEndsAt: null,
      lastAnnouncement: `${announcement} ${winMessage}`,
      players: updatedPlayers,
      nightActions: {},
      dayVotes: {},
      lastTargets: updatedLastTargets,
      detectiveReport
    };
  }

  return {
    ...state,
    phase: 'DAY_VOTING',
    phaseEndsAt: Date.now() + DAY_DURATION_MS,
    lastAnnouncement: announcement,
    players: updatedPlayers,
    nightActions: {},
    dayVotes: {},
    lastTargets: updatedLastTargets,
    detectiveReport
  };
}

function resolveDay(state) {
  const tally = {};
  Object.values(state.dayVotes).forEach((targetId) => {
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let candidateId = null;
  let isTie = false;

  Object.entries(tally).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      candidateId = Number(id);
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  });

  let updatedPlayers = state.players.map((p) => ({ ...p }));
  let announcement = '';

  if (candidateId && !isTie) {
    const exiled = updatedPlayers.find((p) => p.id === candidateId);
    if (exiled) {
      exiled.isAlive = false;
      announcement = `По итогам голосования город покидает ${exiled.username}. `;
    }
  } else {
    announcement = 'Голоса разделились поровну, никто не был исключен. ';
  }

  const winMessage = checkWinCondition(updatedPlayers);
  if (winMessage) {
    return {
      ...state,
      phase: 'GAME_OVER',
      phaseEndsAt: null,
      lastAnnouncement: `${announcement}${winMessage}`,
      players: updatedPlayers,
      dayVotes: {},
      detectiveReport: null
    };
  }

  const nextNightPhase = getNextNightPhase(updatedPlayers, 0) || 'DAY_VOTING';
  return {
    ...state,
    phase: nextNightPhase,
    dayNumber: (state.dayNumber || 1) + 1,
    phaseEndsAt: Date.now() + NIGHT_DURATION_MS,
    lastAnnouncement: `${announcement}Наступает ночь.`,
    players: updatedPlayers,
    nightActions: {},
    dayVotes: {},
    dayAlibiId: null,
    detectiveReport: null
  };
}

function advancePhaseIfExpired(state) {
  if (!state.phaseEndsAt || Date.now() < state.phaseEndsAt) {
    return { state, changed: false };
  }

  const currentIdx = NIGHT_ROLES_ORDER.findIndex((step) => step.phase === state.phase);
  if (currentIdx !== -1) {
    const nextPhase = getNextNightPhase(state.players, currentIdx + 1);
    if (nextPhase) {
      return {
        changed: true,
        state: {
          ...state,
          phase: nextPhase,
          phaseEndsAt: Date.now() + NIGHT_DURATION_MS,
          lastAnnouncement: ''
        }
      };
    }
    return { changed: true, state: resolveNight(state) };
  }

  if (state.phase === 'DAY_VOTING') {
    return { changed: true, state: resolveDay(state) };
  }

  return { state, changed: false };
}

function registerAction(state, userId, targetId) {
  const actor = state.players.find((p) => p.id === userId && p.isAlive);
  if (!actor) return state;

  const target = state.players.find((p) => p.id === targetId && p.isAlive);
  if (!target) return state;

  // Только Доктор может выбирать самого себя
  if (state.phase !== 'NIGHT_DOCTOR' && userId === targetId) {
    return state;
  }

  if (state.phase === 'NIGHT_MISTRESS' && actor.role === 'MISTRESS') {
    if (state.lastTargets?.MISTRESS === targetId) return state;
    state.nightActions.MISTRESS = targetId;
  } else if (state.phase === 'NIGHT_DOCTOR' && actor.role === 'DOCTOR') {
    if (state.lastTargets?.DOCTOR === targetId) return state;
    state.nightActions.DOCTOR = targetId;
  } else if (state.phase === 'NIGHT_MAFIA') {
    const shooter = getActiveMafiaShooter(state.players);
    if (shooter && shooter.id === userId && !isMafiaTeam(target.role)) {
      state.nightActions.MAFIA = targetId;
    }
  } else if (state.phase === 'NIGHT_DETECTIVE' && actor.role === 'DETECTIVE') {
    state.nightActions.DETECTIVE = targetId;
  } else if (state.phase === 'DAY_VOTING') {
    if (state.dayAlibiId === targetId) return state;
    state.dayVotes[userId] = targetId;
  }

  return state;
}

function resetRoomToWaiting(state) {
  return {
    ...state,
    phase: 'WAITING',
    dayNumber: 0,
    phaseEndsAt: null,
    lastAnnouncement: '',
    players: state.players.map((p) => ({
      id: p.id,
      username: p.username,
      role: null,
      isAlive: true
    })),
    nightActions: {},
    dayVotes: {},
    lastTargets: { MISTRESS: null, DOCTOR: null },
    detectiveReport: null
  };
}

module.exports = { 
  isMafiaTeam, 
  checkWinCondition, 
  startGame, 
  advancePhaseIfExpired, 
  registerAction,
  resetRoomToWaiting
};
export const ROOM_ID = /^[a-zA-Z0-9_-]{1,128}$/;

const formats = [
  ['1x1', '1x1', 1], ['2x2', '2x2', 2], ['3x3', '3x3', 3], ['4x4', '4x4', 4],
  ['br-solo', 'Solo', 1, 50], ['br-duo', 'Dupla', 2, 50], ['br-squad', 'Esquadrão', 4, 48],
];
const modes = new Map(formats.map((entry) => [entry[0], entry]));
const rules = new Set(['infiniteGloo', 'infiniteAmmo', 'headshotsOnly', 'friendlyFire']);
const roomStatuses = new Set(['CREATING', 'CREATION_UNKNOWN', 'WAITING_PLAYERS', 'IN_PROGRESS', 'FINISHED', 'CANCELLED', 'FAILED']);

export class HttpError extends Error {
  constructor(status, code, message, { retryAfter, room, uncertain } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.room = room;
    this.uncertain = uncertain;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message) {
  throw new HttpError(400, 'invalid_request', message);
}

function integers(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function roomTeams(value, size, capacity) {
  if (!isObject(value)) invalid('Informe as equipes como listas de IDs do Free Fire.');
  const teams = Object.entries(value);
  if (teams.length < 2 || (!capacity && (teams.length !== 2 || !Object.hasOwn(value, 'A') || !Object.hasOwn(value, 'B')))) {
    invalid('Informe os jogadores de pelo menos duas equipes.');
  }
  const players = new Set();
  const result = {};
  for (const [side, ids] of teams) {
    if (capacity && (!/^T[1-9]\d?$/.test(side) || Number(side.slice(1)) > capacity / size)) {
      invalid('A numeração das equipes ultrapassa a capacidade da sala.');
    }
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > size || (!capacity && ids.length !== size)) {
      invalid(`Confira o número de jogadores na equipe ${side}.`);
    }
    result[side] = ids.map((id) => {
      if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) invalid('Informe IDs de jogadores usando apenas números.');
      if (players.has(id)) invalid('Cada ID de jogador deve aparecer uma única vez.');
      players.add(id);
      return id;
    });
  }
  if (capacity && players.size > capacity) invalid('O número de jogadores ultrapassa a capacidade da sala.');
  return result;
}

export function roomRequest(data) {
  if (!isObject(data) || !modes.has(data.mode)) invalid('Escolha um formato de sala válido.');
  const [, , size, maxCapacity] = modes.get(data.mode);
  const payload = { mode: data.mode };

  if (data.mapId !== undefined) {
    if (!integers(data.mapId, 1, Number.MAX_SAFE_INTEGER)) invalid('Selecione um mapa disponível.');
    payload.mapId = data.mapId;
  }
  if (data.password !== undefined) {
    if (typeof data.password !== 'string' || !/^\d{4,8}$/.test(data.password)) {
      invalid('A senha da sala deve ter de 4 a 8 dígitos.');
    }
    payload.password = data.password;
  }
  if (data.joinTimeoutMinutes !== undefined) {
    if (!integers(data.joinTimeoutMinutes, 2, 60)) invalid('Escolha um prazo de entrada entre 2 e 60 minutos.');
    payload.joinTimeoutMinutes = data.joinTimeoutMinutes;
  }
  if (data.reference !== undefined) {
    if (typeof data.reference !== 'string' || data.reference.length > 100) invalid('A referência pode ter até 100 caracteres.');
    const reference = data.reference.trim();
    if (reference) payload.reference = reference;
  }
  if (maxCapacity) {
    if (!integers(data.maxPlayers, size, maxCapacity) || data.maxPlayers % size !== 0) {
      invalid(`Escolha uma capacidade de até ${maxCapacity} jogadores em múltiplos de ${size}.`);
    }
    payload.maxPlayers = data.maxPlayers;
  } else if (data.maxPlayers !== undefined) {
    invalid('A capacidade personalizada é disponível no modo Battle Royale.');
  }
  if (data.teams !== undefined) payload.teams = roomTeams(data.teams, size, payload.maxPlayers);

  for (const flag of ['autoStart', 'autoResult']) {
    if (data[flag] === undefined) continue;
    if (typeof data[flag] !== 'boolean') invalid('Selecione uma opção válida de automação.');
    if (data[flag] && !payload.teams && (flag === 'autoStart' || !maxCapacity)) {
      invalid('Cadastre as equipes para ativar essa opção de automação.');
    }
    payload[flag] = data[flag];
  }

  if (data.settings !== undefined) {
    if (!isObject(data.settings)) invalid('As regras da sala são inválidas.');
    const settings = Object.entries(data.settings);
    if (settings.length && maxCapacity) invalid('As regras personalizadas são disponíveis no modo Contra Squad.');
    if (settings.some(([name, value]) => !rules.has(name) || typeof value !== 'boolean')) {
      invalid('Selecione uma regra de sala disponível.');
    }
    if (settings.length) payload.settings = Object.fromEntries(settings);
  }
  return payload;
}

function asText(value, length = 160) {
  return typeof value === 'string' && value.length ? value.slice(0, length) : null;
}

function asCount(value) {
  return integers(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
}

function accountId(value) {
  const id = typeof value === 'string' ? value : (asCount(value)?.toString() ?? '');
  return /^\d{1,20}$/.test(id) ? id : null;
}

function teamId(value) {
  const id = typeof value === 'string' ? value : (asCount(value)?.toString() ?? '');
  return /^[a-zA-Z0-9_-]{1,60}$/.test(id) ? id : null;
}

function playerResult(id, value) {
  const player = accountId(id);
  if (!player || !isObject(value)) return null;
  return {
    accountId: player,
    teamId: teamId(value.teamId ?? value.team),
    kills: asCount(value.kills),
    deaths: asCount(value.deaths),
    damage: Number.isFinite(value.damage) && value.damage >= 0 ? value.damage : null,
  };
}

function teamResult(value) {
  const id = teamId(value?.teamId);
  if (!id) return null;
  const placement = asCount(value.placement ?? value.place ?? value.rank);
  return { teamId: id, placement: placement > 0 ? placement : null };
}

function publicResult(value) {
  if (!isObject(value) || !['NONE', 'PENDING', 'CONFIRMED'].includes(value.status)) return null;
  const result = { status: value.status, source: null, winner: null, winnerTeamId: null, players: [], teams: [] };
  if (value.status !== 'CONFIRMED') return result;

  if (['AUTO', 'MANUAL'].includes(value.source)) result.source = value.source;
  if (['A', 'B'].includes(value.winner)) result.winner = value.winner;
  result.winnerTeamId = teamId(value.winnerTeamId);
  if (Array.isArray(value.players)) {
    result.players = value.players.map((player) => playerResult(player?.accountId, player)).filter(Boolean);
  } else if (isObject(value.stats)) {
    result.players = Object.entries(value.stats).map(([id, player]) => playerResult(id, player)).filter(Boolean);
  }
  if (Array.isArray(value.teams)) result.teams = value.teams.map(teamResult).filter(Boolean);
  return result;
}

export function publicAccount(value) {
  if (!isObject(value) || !isObject(value.usage)) return null;
  const { roomsRemaining, roomsLimit, activeRooms, concurrentLimit } = value.usage;
  return {
    name: asText(value.name),
    plan: { name: asText(value.plan?.name) },
    usage: {
      roomsRemaining: asCount(roomsRemaining),
      roomsLimit: asCount(roomsLimit),
      activeRooms: asCount(activeRooms),
      concurrentLimit: asCount(concurrentLimit),
    },
  };
}

export function publicRoom(value, { includePassword = true } = {}) {
  if (!isObject(value) || typeof value.id !== 'string' || !ROOM_ID.test(value.id) || !asText(value.status, 50)) return null;
  const status = roomStatuses.has(value.status) ? value.status : 'UNKNOWN';
  return {
    id: value.id,
    roomId: asText(value.roomId, 50) ?? (asCount(value.roomId) === null ? null : String(value.roomId)),
    status,
    mode: asText(value.mode, 32),
    map: asText(value.map ?? value.mapName, 80),
    name: asText(value.name, 80),
    password: includePassword && status === 'WAITING_PLAYERS' && typeof value.password === 'string' && /^\d{4,8}$/.test(value.password) ? value.password : null,
    joinDeadline: asText(value.joinDeadline, 40),
    createdAt: asText(value.createdAt, 40),
    reference: asText(value.reference, 100),
    maxPlayers: asCount(value.maxPlayers),
    autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : null,
    autoResult: typeof value.autoResult === 'boolean' ? value.autoResult : null,
    result: publicResult(value.result),
  };
}

export function pendingRoom(room) {
  return room?.status === 'CREATING' || room?.status === 'CREATION_UNKNOWN';
}

function collection(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  return Object.entries(value).map(([id, entry]) => isObject(entry) ? { id, ...entry } : { id, name: entry });
}

export function publicModes(value) {
  const catalog = value?.data ?? value;
  const listed = collection(catalog?.modes ?? catalog);
  const allMaps = collection(catalog?.maps);
  return {
    modes: formats.map(([id, label, teamSize, capacity]) => {
      const mode = listed.find((entry) => (entry?.mode ?? entry?.id ?? entry?.key) === id);
      const group = capacity ? (catalog?.maps?.br ?? catalog?.maps?.battleRoyale) : catalog?.maps?.cs;
      const mapChoices = collection(mode?.maps ?? mode?.mapIds ?? group ?? allMaps);
      const maps = new Map();
      for (const entry of mapChoices) {
        const mapId = Number(entry?.mapId ?? entry?.id ?? entry);
        if (!integers(mapId, 1, Number.MAX_SAFE_INTEGER)) continue;
        const knownMap = allMaps.find((item) => Number(item?.mapId ?? item?.id) === mapId);
        const name = asText(entry?.name ?? entry?.label ?? knownMap?.name ?? knownMap?.label, 80);
        if (name || mapId === 1) maps.set(mapId, { id: mapId, name: name ?? 'Mapa padrão' });
      }
      if (maps.size === 0) maps.set(1, { id: 1, name: 'Mapa padrão' });
      return { id, label, teamSize, maps: [...maps.values()] };
    }),
  };
}

import { createDemoApi, presets } from './demo.js';

const byId = (id) => document.getElementById(id);
const roomForm = byId('room-form');
const connectionForm = byId('connection-form');
const defaultMap = { id: 1, name: 'Bermuda' };
const formatDetails = {
  '1x1': ['1x1', 1, 'Duelo'], '2x2': ['2x2', 2, 'Duplas'],
  '3x3': ['3x3', 3, 'Trios'], '4x4': ['4x4', 4, 'Squad'],
  'br-solo': ['Solo', 1, 'Individual', 50], 'br-duo': ['Dupla', 2, '2 por equipe', 50],
  'br-squad': ['Esquadrão', 4, '4 por equipe', 48],
};
const defaultModes = Object.entries(formatDetails).map(([id, [label, teamSize]]) => ({ id, label, teamSize, maps: [defaultMap] }));
const statusInfo = {
  CREATING: ['Em criação', 'pending', 'Aguarde a confirmação da API.'],
  CREATION_UNKNOWN: ['Em conferência', 'pending', 'A API está conferindo se a sala foi criada.'],
  WAITING_PLAYERS: ['Aguardando jogadores', 'ready', 'Compartilhe o ID e a senha com os jogadores.'],
  IN_PROGRESS: ['Em andamento', 'ready', 'A partida começou. Acompanhe o resultado abaixo.'],
  FINISHED: ['Encerrada', '', 'A partida foi encerrada.'],
  CANCELLED: ['Cancelada', 'error', 'A sala foi cancelada.'],
  FAILED: ['Falha na criação', 'error', 'A API confirmou a falha. Você pode criar outra sala.'],
};
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat('pt-BR');
const minimumCharacterMessage = 'Deixe pelo menos um personagem liberado para criar a sala com bloqueios.';

let catalog = defaultModes;
let characters = [];
let petCatalogs = {};
let petRule = 'pets';
let loadingModes = false;
const blockedCharacters = new Set();
const petSelections = {
  cs: { pets: new Set(), petSkills: new Set() },
  br: { pets: new Set(), petSkills: new Set() },
};
let family = 'cs';
let mode = defaultModes[1];
let connected = false;
let sessionVersion = 0;
let attempt;
let currentRoom;
let submitting = false;
let checking = false;
let roomAction;
let matchResultSignature;
let pollTimer;
let historyBusy = false;
let historyCursor;
let historyRooms = [];
let inboxTimer;
let inboxLoading = false;
let inboxState;
let demo;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(id, text, kind = '') {
  const node = byId(id);
  node.textContent = text;
  node.dataset.kind = kind;
  node.hidden = !text;
}

function rows(id, entries) {
  byId(id).replaceChildren(...entries.map(([term, value]) => {
    const row = element('div');
    row.append(element('dt', term), element('dd', value ?? '—'));
    return row;
  }));
}

function tableRows(id, entries) {
  byId(id).replaceChildren(...entries.map((entry) => {
    const row = element('tr');
    row.append(...entry.map((value) => element('td', value ?? '—')));
    return row;
  }));
}

function date(value) {
  const stamp = value && new Date(value);
  return stamp && Number.isFinite(+stamp) ? dateFormat.format(stamp) : '—';
}

function modeLabel(id) {
  return catalog.find((entry) => entry.id === id)?.label ?? formatDetails[id]?.[0] ?? id ?? '—';
}

async function api(path, { method = 'GET', body } = {}) {
  if (demo) return demo(path, { method, body });
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await response.json();
  if (response.ok) return data;
  const error = new Error(data.error?.message ?? 'Não foi possível concluir a solicitação.');
  error.code = data.error?.code;
  error.room = data.room;
  error.characterValidation = data.error?.details?.characterValidation;
  error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
  throw error;
}

function serverMessage(error) {
  if (!error.code) return 'O portal perdeu a conexão. Verifique a rede e tente novamente.';
  return error.retryAfter ? `${error.message} Aguarde ${error.retryAfter} s.` : error.message;
}

function renderModes(preferred = mode?.id) {
  const isBr = family === 'br';
  const formats = catalog.filter((entry) => entry.id.startsWith('br-') === isBr);
  mode = formats.find((entry) => entry.id === preferred) ?? formats.find((entry) => entry.id === '2x2') ?? formats[0];
  const modeGrid = byId('modes');
  modeGrid.classList.toggle('is-br', isBr);
  modeGrid.replaceChildren(...formats.map((entry) => {
    const tile = element('label');
    const input = element('input');
    input.type = 'radio';
    input.name = 'mode';
    input.value = entry.id;
    input.checked = entry.id === mode?.id;
    const content = element('span', undefined, 'mode-tile');
    content.append(element('strong', entry.label), element('small', formatDetails[entry.id][2]));
    tile.append(input, content);
    return tile;
  }));
  if (!mode) modeGrid.append(element('p', 'A API não disponibilizou formatos para esse tipo de partida.', 'helper'));
  renderModeFields();
}

function replaceOptions(select, options) {
  const previous = select.value;
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  if (options.some(([value]) => String(value) === previous)) select.value = previous;
}

function renderModeFields() {
  const isBr = family === 'br';
  const size = mode?.teamSize ?? 1;
  byId('capacity-field').hidden = !isBr || !mode;
  byId('cs-rules').hidden = isBr;
  byId('cs-teams').hidden = isBr;
  byId('br-teams').hidden = !isBr;
  byId('team-guide').textContent = isBr
    ? `Informe pelo menos duas equipes, uma por linha, com até ${size} ID(s) por equipe. Separe os IDs com vírgulas.`
    : `Informe ${size} ID(s) por time, separados por vírgulas. Cada jogador deve aparecer uma única vez.`;

  replaceOptions(byId('map'), (mode?.maps?.length ? mode.maps : [defaultMap]).map(({ id, name }) => [id, name]));
  if (isBr && mode) {
    const max = formatDetails[mode.id][3];
    const capacity = byId('capacity');
    const previous = Number(capacity.value);
    const values = Array.from({ length: max / size - 1 }, (_, index) => size * (index + 2));
    replaceOptions(capacity, values.map((value) => [value, `${value} jogadores`]));
    if (!values.includes(previous)) capacity.value = max;
  }
  renderPetPicker();
  renderSummary();
}

function searchText(value) {
  return value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
}

function filterChoices(search, list, empty) {
  const query = searchText(byId(search).value);
  let visible = 0;
  for (const choice of byId(list).children) {
    choice.hidden = !choice.dataset.search.includes(query);
    if (!choice.hidden) visible += 1;
  }
  byId(empty).hidden = visible > 0;
}

function choiceList(list, items, selected) {
  byId(list).replaceChildren(...items.map(({ id, name }) => {
    const choice = element('label', undefined, 'character-choice');
    choice.dataset.search = searchText(`${name} ${id}`);
    const input = element('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = selected.has(id);
    choice.append(input, element('span', name));
    return choice;
  }));
}

function filterCharacters() {
  filterChoices('character-search', 'character-list', 'no-character-matches');
}

function renderCharacterSelection() {
  const count = blockedCharacters.size;
  const allowed = characters.length - count;
  const label = count === 1 ? '1 bloqueado' : `${count} bloqueados`;
  const badge = byId('character-badge');
  badge.hidden = count === 0;
  badge.textContent = label;
  byId('clear-characters').disabled = count === 0;
  byId('character-count').textContent = count === 0 ? 'Sem bloqueios'
    : allowed === 0 ? 'Deixe pelo menos um personagem liberado.'
      : `${label} · ${allowed === 1 ? '1 liberado' : `${allowed} liberados`}`;
  if (allowed > 0 && byId('form-message').textContent === minimumCharacterMessage) notice('form-message', '');
  renderSummary();
}

function renderCharacterPicker() {
  byId('character-picker').hidden = characters.length === 0 || loadingModes;
  byId('retry-character-catalog').hidden = !connected || loadingModes || characters.length > 0;
  const message = !connected ? 'Conecte sua chave da Lobbito para carregar o catálogo.'
    : loadingModes ? 'Carregando personagens…'
      : !characters.length ? 'A Lobbito não disponibilizou o catálogo de personagens nesta sessão.' : '';
  notice('character-catalog-message', message);
  choiceList('character-list', characters, blockedCharacters);
  filterCharacters();
  renderCharacterSelection();
}

function filterPets() {
  filterChoices('pet-search', 'pet-list', 'no-pet-matches');
}

function renderPetSelection() {
  const selection = petSelections[family];
  const count = selection[petRule].size;
  const total = selection.pets.size + selection.petSkills.size;
  const badge = byId('pet-badge');
  badge.hidden = total === 0;
  badge.textContent = total === 1 ? '1 bloqueio' : `${total} bloqueios`;
  byId('pet-count').textContent = count === 0 ? 'Sem bloqueios' : count === 1 ? '1 selecionado' : `${count} selecionados`;
  byId('clear-pet-selection').disabled = count === 0;
  renderSummary();
}

function renderPetPicker() {
  const group = petCatalogs[family];
  const visual = Boolean(group?.pets?.length);
  const skills = Boolean(group?.petSkills?.length);
  if (!group?.[petRule]?.length) petRule = skills ? 'petSkills' : 'pets';
  const show = connected && !loadingModes && (visual || skills);
  byId('pet-picker').hidden = !show;
  byId('pet-rule-types').hidden = !(visual && skills);
  for (const input of byId('pet-rule-types').querySelectorAll('input')) input.checked = petRule === input.value;
  const message = !connected ? 'Conecte sua chave da Lobbito para carregar o catálogo.'
    : loadingModes ? 'Carregando o catálogo de pets…'
      : !show ? 'A Lobbito não disponibilizou regras de pets para este modo.' : '';
  notice('pet-catalog-message', message);
  byId('pet-rule-hint').textContent = petRule === 'petSkills'
    ? 'Marque as habilidades que serão bloqueadas. O visual do pet continua livre nesta regra.'
    : 'Marque os visuais que serão bloqueados. A regra usa o pet equipado no visual.';
  byId('pet-search-label').textContent = petRule === 'petSkills' ? 'Buscar habilidade de pet' : 'Buscar pet';
  byId('pet-list').setAttribute('aria-label', petRule === 'petSkills' ? 'Habilidades de pet para bloquear' : 'Visuais de pet para bloquear');
  choiceList('pet-list', group?.[petRule] ?? [], petSelections[family][petRule]);
  filterPets();
  renderPetSelection();
}

function renderSummary() {
  const isBr = family === 'br';
  const size = mode?.teamSize ?? 0;
  byId('match').hidden = isBr || !mode;
  for (const id of ['players-a', 'players-b']) byId(id).replaceChildren(...Array.from({ length: size }, () => element('i')));
  rows('summary-list', [
    ['Formato', mode ? `${isBr ? 'BR · ' : ''}${mode.label}` : null],
    ['Mapa', mode ? byId('map').selectedOptions[0]?.text : null],
    ['Jogadores', mode ? (isBr ? `Até ${byId('capacity').value}` : String(size * 2)) : null],
    ['Prazo de entrada', byId('deadline').validity.valid ? `${byId('deadline').value} min` : null],
    ['Senha', byId('room-password').value ? 'Personalizada' : 'Automática'],
    ...(blockedCharacters.size ? [['Personagens bloqueados', blockedCharacters.size]] : []),
    ...(petSelections[family].pets.size ? [['Visuais de pet bloqueados', petSelections[family].pets.size]] : []),
    ...(petSelections[family].petSkills.size ? [['Habilidades de pet bloqueadas', petSelections[family].petSkills.size]] : []),
  ]);
  const blocked = Boolean(submitting || roomAction || attempt?.pending);
  byId('create').disabled = blocked || !mode;
  byId('create-label').textContent = submitting ? 'Enviando pedido…' : attempt?.pending ? 'Aguardando pedido anterior' : demo ? 'Simular criação' : 'Criar sala';
  const trackWithoutTeams = isBr || byId('use-teams').checked;
  byId('auto-result').disabled = !trackWithoutTeams;
  byId('auto-result-hint').textContent = trackWithoutTeams
    ? 'O portal exibe o resultado assim que a Lobbito o disponibilizar.'
    : 'Cadastre os jogadores dos dois times para acompanhar o resultado de Contra Squad.';
}

function renderAccount(account) {
  const usage = account?.usage;
  const displayCount = (count) => typeof count === 'number' ? numberFormat.format(count) : '—';
  rows('account-info', [
    ['Conta', account?.name], ['Plano', account?.plan?.name],
    ['Salas restantes', displayCount(usage?.roomsRemaining)],
    ['Salas ativas', `${displayCount(usage?.activeRooms)} / ${displayCount(usage?.concurrentLimit)}`],
  ]);
  byId('quota-hint').textContent = usage?.roomsRemaining === 0
    ? 'A conta atingiu a cota de salas. Consulte seu plano na Lobbito.'
    : 'A criação usa a cota de salas da sua conta Lobbito.';
}

function renderConnection(account) {
  byId('connection-label').textContent = demo ? 'Demonstração' : connected ? 'API conectada' : 'API desconectada';
  byId('connection-state').classList.toggle('is-connected', connected);
  byId('connection-description').textContent = demo ? 'Salas e resultados simulados neste navegador.'
    : connected ? 'Saldo e uso de salas da sua conta.' : 'Use a chave da sua conta Lobbito.';
  connectionForm.hidden = connected;
  byId('connected').hidden = !connected;
  byId('get-key').hidden = connected;
  byId('start-demo').hidden = connected;
  byId('disconnect').textContent = demo ? 'Sair da demonstração' : 'Desconectar';
  byId('disconnect').disabled = Boolean(submitting || attempt?.inFlight);
  byId('refresh-history').disabled = !connected || historyBusy;
  renderAccount(account);
}

function displayedRoom() {
  return currentRoom ?? attempt?.room;
}

function resultWinner(result) {
  if (result?.status !== 'CONFIRMED') return null;
  if (result.winner) return `Time ${result.winner}`;
  return result.winnerTeamId ? `Equipe ${result.winnerTeamId}` : null;
}

function renderMatchResult(room) {
  const result = room?.result;
  const confirmed = result?.status === 'CONFIRMED';
  const pending = result?.status === 'PENDING';
  const finished = room?.status === 'FINISHED';
  const inProgress = room?.status === 'IN_PROGRESS';
  const section = byId('match-result');
  section.hidden = !(confirmed || pending || finished || inProgress);
  if (section.hidden) {
    matchResultSignature = undefined;
    return;
  }
  const signature = JSON.stringify([room.id, room.status, room.autoResult, room.mode, result]);
  if (signature === matchResultSignature) return;
  matchResultSignature = signature;

  const battleRoyale = room.mode?.startsWith('br-');
  const winner = resultWinner(result);
  const source = result?.source === 'MANUAL' ? ' Confirmação manual.'
    : result?.source === 'AUTO' ? ' Confirmação automática da Lobbito.' : '';
  const label = confirmed ? 'Confirmado' : pending ? 'Pendente' : finished ? 'Indisponível' : room.autoResult === false ? 'Desativado' : 'Aguardando';
  const status = byId('match-result-status');
  if (status.textContent !== label) status.textContent = label;
  status.dataset.kind = confirmed ? 'ready' : pending || inProgress ? 'pending' : '';
  const summary = confirmed ? `${winner ? (battleRoyale ? `Booyah — ${winner}.` : `Vencedor — ${winner}.`) : 'A Lobbito confirmou o resultado.'}${source}`
    : pending ? 'A Lobbito sinalizou que o resultado precisa de conferência.'
      : room.autoResult === false ? 'O acompanhamento automático estava desativado para esta sala.'
        : finished ? 'A Lobbito ainda não disponibilizou um resultado.' : 'O portal acompanha a partida e atualiza esta área quando houver um resultado.';
  byId('match-result-summary').textContent = summary;

  const teams = confirmed ? (result.teams ?? []).filter(({ placement }) => placement !== null && placement !== undefined) : [];
  byId('match-team-table').hidden = teams.length === 0;
  tableRows('match-team-rows', [...teams].sort((a, b) => a.placement - b.placement).map(({ placement, teamId }) => [`${placement}º`, teamId]));

  const players = confirmed ? result.players ?? [] : [];
  const stats = [['kills', 'Abates'], ['deaths', 'Mortes'], ['damage', 'Dano']];
  const columns = [['accountId', 'ID do jogador'], ['teamId', 'Equipe'], ...stats].filter(([key]) => players.some((player) => player[key] !== null && player[key] !== undefined));
  const header = element('tr');
  header.append(...columns.map(([, heading]) => {
    const th = element('th', heading);
    th.scope = 'col';
    return th;
  }));
  byId('match-player-head').replaceChildren(header);
  byId('match-player-table').hidden = players.length === 0;
  tableRows('match-player-rows', players.map((player) => columns.map(([key]) => player[key])));
}

function renderCharacterValidation(room) {
  const validation = room?.characterValidation;
  const info = {
    PENDING: ['Aguardando', 'pending', 'A Lobbito está conferindo as escolhas dos jogadores.'],
    VALID: ['Aprovado', 'ready', 'Os jogadores conferidos seguem as regras da sala.'],
    INVALID: ['Bloqueio detectado', 'error', 'Os jogadores indicados precisam ajustar as escolhas antes do início.'],
    UNAVAILABLE: ['Indisponível', 'pending', 'A conferência ainda não foi concluída. Atualize a sala antes de tentar iniciar.'],
  }[validation?.status];
  byId('character-check').hidden = !info || room?.status !== 'WAITING_PLAYERS';
  if (!info || room?.status !== 'WAITING_PLAYERS') return;
  const [label, kind, message] = info;
  const status = byId('character-check-status');
  if (status.textContent !== label) status.textContent = label;
  status.dataset.kind = kind;
  byId('character-check-message').textContent = message;
  const violations = validation.violations ?? [];
  const list = byId('character-check-violations');
  list.hidden = violations.length === 0;
  list.replaceChildren(...violations.map((violation) => {
    const { accountId, reason } = violation;
    const names = {
      NOT_ALLOWED: ['habilidade de personagem bloqueada', violation.characterName, violation.characterId],
      CHARACTER_BLOCKED: ['habilidade de personagem bloqueada', violation.characterName, violation.characterId],
      UNKNOWN_CHARACTER: ['habilidade sem personagem identificado'],
      PET_NOT_ALLOWED: ['visual de pet bloqueado', violation.petName, violation.petId],
      PET_SKILL_NOT_ALLOWED: ['habilidade de pet bloqueada', violation.petSkillName, violation.petSkillId],
    };
    const [message, name, id] = names[reason] ?? ['regra da sala não atendida'];
    const item = name || (id == null ? '' : `ID ${id}`);
    return element('li', `Jogador ${accountId} · ${message}${item ? ` (${item})` : ''}`);
  }));
}

function showResult() {
  const room = displayedRoom();
  const result = byId('result');
  const needsRecovery = attempt?.pending && !attempt.room;
  const viewingAttempt = !currentRoom || room?.id === attempt?.room?.id;
  result.hidden = !room && !attempt?.pending && !attempt?.error;
  renderMatchResult(room);
  renderCharacterValidation(room);
  if (result.hidden) return;
  const info = room
    ? statusInfo[room.status] ?? ['Status atualizado', '', 'Consulte a sala novamente para acompanhar a partida.']
    : attempt?.inFlight ? ['Enviando', 'pending', 'A API pode levar alguns segundos para responder.']
      : needsRecovery ? ['Sem confirmação', 'pending', 'Verifique o mesmo pedido para evitar criar uma sala duplicada.']
        : ['Pedido recusado', 'error', attempt?.error?.message ?? 'A API recusou o pedido.'];
  byId('result-title').textContent = room ? (room.name || 'Sala na Lobbito') : 'Pedido de criação';
  if (byId('result-status').textContent !== info[0]) byId('result-status').textContent = info[0];
  byId('result-status').dataset.kind = info[1];
  const message = byId('result-message');
  message.textContent = demo && room?.status === 'WAITING_PLAYERS' ? 'Sala simulada pronta. Inicie para acompanhar o resultado.'
    : room?.status === 'WAITING_PLAYERS' && room.autoStart === false
      ? `${info[2]} Inicie quando todos estiverem prontos.` : info[2];
  const details = [];
  if (needsRecovery && attempt.protocol) details.push(['Protocolo do pedido', attempt.protocol]);
  if (room?.roomId) details.push(['ID no jogo', room.roomId]);
  if (room?.status === 'WAITING_PLAYERS' && room.password) details.push(['Senha', room.password]);
  if (room?.joinDeadline) details.push(['Entrada até', date(room.joinDeadline)]);
  if (room?.reference) details.push(['Referência', room.reference]);
  rows('result-details', details);
  byId('copy-room').hidden = !(room?.status === 'WAITING_PLAYERS' && room.roomId);
  byId('refresh-room').hidden = !room?.id;
  const canManage = room?.status === 'WAITING_PLAYERS';
  byId('start-room').hidden = !canManage;
  byId('cancel-room').hidden = !canManage;
  byId('start-room').disabled = Boolean(roomAction || checking || submitting);
  byId('cancel-room').disabled = Boolean(roomAction || checking || submitting);
  byId('refresh-room').disabled = Boolean(roomAction || checking);
  byId('start-room').textContent = roomAction === 'start' ? 'Iniciando…' : 'Iniciar partida';
  byId('cancel-room').textContent = roomAction === 'cancel' ? 'Cancelando…' : 'Cancelar sala';
  byId('retry-room').hidden = !needsRecovery || attempt?.inFlight;
  byId('retry-room').textContent = viewingAttempt ? 'Verificar pedido' : 'Verificar pedido pendente';
  byId('retry-room').disabled = submitting;
  byId('close-pending').hidden = !needsRecovery || !attempt.canClose;
  byId('close-pending').disabled = submitting || Boolean(attempt?.inFlight);
  byId('disconnect').disabled = Boolean(roomAction || submitting || attempt?.inFlight);
}

function resetSession(message = '') {
  sessionVersion += 1;
  connected = false;
  catalog = defaultModes;
  characters = [];
  petCatalogs = {};
  petRule = 'pets';
  for (const selection of Object.values(petSelections)) {
    selection.pets.clear();
    selection.petSkills.clear();
  }
  byId('pet-search').value = '';
  loadingModes = false;
  blockedCharacters.clear();
  byId('character-search').value = '';
  attempt = undefined;
  currentRoom = undefined;
  submitting = false;
  checking = false;
  roomAction = undefined;
  if (byId('cancel-dialog').open) byId('cancel-dialog').close();
  historyBusy = false;
  historyRooms = [];
  historyCursor = undefined;
  inboxState = undefined;
  inboxLoading = false;
  clearTimeout(inboxTimer);
  clearTimeout(pollTimer);
  renderConnection();
  renderModes();
  renderCharacterPicker();
  renderHistory();
  renderInbox();
  showResult();
  notice('form-message', '');
  notice('room-action-message', '');
  notice('connection-message', message, message ? 'error' : '');
}

function handleAuth(error, version) {
  if (version !== sessionVersion) return true;
  if (error.code === 'session_required' || error.code === 'unauthorized') {
    resetSession('Sua conexão com a Lobbito expirou ou a chave foi revogada. Conecte novamente.');
    return true;
  }
  return false;
}

async function refreshAccount() {
  const version = sessionVersion;
  try {
    const account = await api('/account');
    if (version === sessionVersion) renderAccount(account);
  } catch (error) {
    if (!handleAuth(error, version)) notice('connection-message', serverMessage(error), 'error');
  }
}

async function loadModes() {
  if (loadingModes || !connected) return;
  const version = sessionVersion;
  loadingModes = true;
  renderCharacterPicker();
  renderPetPicker();
  try {
    const data = await api('/modes');
    if (version !== sessionVersion) return;
    const supported = data.modes.filter((entry) => Object.hasOwn(formatDetails, entry.id));
    if (!supported.length) throw new Error('Catálogo vazio');
    catalog = supported;
    characters = [...(data.characters ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    petCatalogs = data.petCatalogs ?? {};
    renderModes();
  } catch (error) {
    if (!handleAuth(error, version)) notice('connection-message', 'Não foi possível atualizar o catálogo de mapas. O portal oferece o mapa padrão.', 'error');
  } finally {
    if (version === sessionVersion) {
      loadingModes = false;
      renderCharacterPicker();
      renderPetPicker();
    }
  }
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  if (!connected || roomAction || submitting || checking || byId('cancel-dialog').open) return;
  if (attempt?.pending && attempt.inFlight && !attempt.room?.id) {
    pollTimer = setTimeout(() => void recoverSessionAttempt(), delay ?? 2500);
    return;
  }
  const room = attempt?.pending && attempt.room?.id ? attempt.room : displayedRoom();
  if (!room?.id) return;
  const intervals = { CREATING: 10000, CREATION_UNKNOWN: 10000, WAITING_PLAYERS: 10000, IN_PROGRESS: 15000 };
  const interval = intervals[room.status] ?? (room.result?.status === 'PENDING' ? 30000 : null);
  if (interval) pollTimer = setTimeout(() => void checkRoom(room.id, true), delay ?? interval);
}

function updateAttempt(value) {
  attempt = value;
  showResult();
  renderSummary();
  schedulePoll(value?.inFlight ? 2500 : undefined);
}

async function recoverSessionAttempt() {
  const version = sessionVersion;
  try {
    const session = await api('/session');
    if (version !== sessionVersion) return;
    if (!session.connected) {
      resetSession('A sessão expirou. Conecte novamente para consultar o histórico.');
      return;
    }
    updateAttempt(session.attempt);
  } catch (error) {
    if (!handleAuth(error, version)) {
      notice('form-message', serverMessage(error), 'error');
      if (attempt?.inFlight) schedulePoll(6500);
    }
  }
}

function beginSession(session) {
  sessionVersion += 1;
  connected = true;
  renderConnection(session.account);
  updateAttempt(session.attempt);
  void loadModes();
  void loadHistory();
  void loadInbox();
  if (attempt?.pending && !attempt.inFlight && !attempt.room) void sendRoom(undefined, true);
}

function parseIds(value) {
  return value.trim().split(/[\s,]+/).filter(Boolean);
}

function formPayload() {
  const isBr = family === 'br';
  const payload = { mode: mode.id, mapId: Number(byId('map').value), joinTimeoutMinutes: Number(byId('deadline').value) };
  const password = byId('room-password').value;
  const reference = byId('reference').value.trim();
  if (password) payload.password = password;
  if (reference) payload.reference = reference;
  if (isBr) payload.maxPlayers = Number(byId('capacity').value);
  if (!isBr) {
    const rules = [...document.querySelectorAll('[data-rule]')].filter((input) => input.value !== '');
    if (rules.length) payload.settings = Object.fromEntries(rules.map((input) => [input.dataset.rule, input.value === 'true']));
  }
  if (blockedCharacters.size) {
    const allowed = characters.filter(({ id }) => !blockedCharacters.has(id)).map(({ id }) => id);
    if (!allowed.length) {
      byId('character-rules').open = true;
      throw new Error(minimumCharacterMessage);
    }
    payload.settings = { ...payload.settings, allowedCharacterIds: allowed.sort((a, b) => a - b) };
  }
  const selection = petSelections[family];
  if (selection.pets.size) {
    payload.settings ??= {};
    payload.settings.blockedPetIds = [...selection.pets].sort((a, b) => a - b);
  }
  if (selection.petSkills.size) {
    payload.settings ??= {};
    payload.settings.blockedPetSkillIds = [...selection.petSkills].sort((a, b) => a - b);
  }

  if (byId('use-teams').checked) {
    payload.teams = isBr
      ? Object.fromEntries(byId('team-lines').value.trim().split(/\r?\n/).map(parseIds).filter((ids) => ids.length).map((ids, index) => [`T${index + 1}`, ids]))
      : { A: parseIds(byId('team-a').value), B: parseIds(byId('team-b').value) };
    const teams = Object.values(payload.teams);
    if (isBr && (teams.length < 2 || teams.length > payload.maxPlayers / mode.teamSize)) throw new Error('Informe pelo menos duas equipes e respeite a capacidade da sala.');
    if (teams.some((team) => isBr ? team.length > mode.teamSize : team.length !== mode.teamSize)) throw new Error('Confira o número de jogadores em cada equipe.');
    const ids = teams.flat();
    if (ids.some((id) => !/^\d{1,20}$/.test(id))) throw new Error('Informe somente IDs numéricos de jogadores.');
    if (new Set(ids).size !== ids.length) throw new Error('Cada ID de jogador deve aparecer uma única vez.');
    payload.autoStart = byId('auto-start').checked;
  }
  if (isBr || payload.teams) payload.autoResult = byId('auto-result').checked;
  return payload;
}

function isPending(room) {
  return room.status === 'CREATING' || room.status === 'CREATION_UNKNOWN';
}

async function sendRoom(payload, retry = false) {
  if (submitting || roomAction) return;
  const version = sessionVersion;
  const previous = attempt;
  submitting = true;
  currentRoom = undefined;
  notice('room-action-message', '');
  updateAttempt({ pending: true, inFlight: true });
  clearTimeout(pollTimer);
  notice('form-message', '');
  if (matchMedia('(max-width: 640px)').matches) byId('result').scrollIntoView({ block: 'nearest' });
  try {
    const { room } = await api(retry ? '/retry' : '/rooms', { method: 'POST', body: payload });
    if (version !== sessionVersion) return;
    updateAttempt({ room, pending: isPending(room) });
    if (!isPending(room)) {
      void refreshAccount();
      void loadHistory();
    }
  } catch (error) {
    if (handleAuth(error, version)) return;
    notice('form-message', serverMessage(error), 'error');
    if (error.room) {
      updateAttempt({ room: error.room, pending: isPending(error.room) });
      void refreshAccount();
      void loadHistory();
    } else {
      updateAttempt({ ...previous, pending: true, inFlight: true });
      clearTimeout(pollTimer);
      await recoverSessionAttempt();
    }
  } finally {
    if (version === sessionVersion) {
      submitting = false;
      renderSummary();
      showResult();
      schedulePoll();
    }
  }
}

function applyRoom(room, select) {
  if (select) {
    if (displayedRoom()?.id !== room.id) notice('room-action-message', '');
    currentRoom = room;
  }
  if (currentRoom?.id === room.id) currentRoom = room;
  if (attempt?.room?.id === room.id) updateAttempt({ room, pending: isPending(room) });
  const historyIndex = historyRooms.findIndex(({ id }) => id === room.id);
  if (historyIndex !== -1) {
    const previous = historyRooms[historyIndex];
    historyRooms[historyIndex] = room;
    if (previous.status !== room.status || previous.result?.status !== room.result?.status || resultWinner(previous.result) !== resultWinner(room.result)) renderHistory();
  }
  showResult();
}

async function checkRoom(id, background = false) {
  if (checking || roomAction || !connected) {
    if (background) schedulePoll();
    return;
  }
  const version = sessionVersion;
  checking = true;
  showResult();
  let delay;
  try {
    const room = await api(`/rooms/${encodeURIComponent(id)}`);
    if (version !== sessionVersion) return;
    const previous = attempt?.room?.id === id ? attempt.room : displayedRoom()?.id === id ? displayedRoom() : undefined;
    const wasPending = previous && isPending(previous);
    applyRoom(room, !background);
    if (!background) {
      notice('form-message', '');
      byId('result').scrollIntoView({ block: 'nearest' });
    }
    if (previous && previous.status !== room.status && (wasPending || ['CANCELLED', 'FINISHED', 'FAILED'].includes(room.status))) {
      void refreshAccount();
      void loadHistory();
    }
  } catch (error) {
    if (handleAuth(error, version)) return;
    const message = serverMessage(error);
    if (background || currentRoom?.id === id || attempt?.room?.id === id) notice('form-message', message, 'error');
    else notice('history-message', message, 'error');
    delay = Math.max(10000, error.retryAfter * 1000 || 0);
  } finally {
    if (version === sessionVersion) {
      checking = false;
      showResult();
      schedulePoll(delay);
    }
  }
}

async function manageRoom(action, id) {
  const selected = displayedRoom();
  if (roomAction || submitting || checking || !connected || !id || id !== selected?.id || selected.status !== 'WAITING_PLAYERS') return;
  const version = sessionVersion;
  roomAction = action;
  clearTimeout(pollTimer);
  showResult();
  renderSummary();
  notice('room-action-message', action === 'start' ? 'Solicitando o início à Lobbito…' : 'Solicitando o cancelamento à Lobbito…');
  let needsRefresh = true;
  try {
    const { room } = await api(`/rooms/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    if (version !== sessionVersion) return;
    if (room) applyRoom(room, false);
    needsRefresh = !room || room.status === 'WAITING_PLAYERS';
    const confirmed = action === 'cancel' && room?.status === 'CANCELLED' ? 'Sala cancelada.'
      : action === 'start' && (room?.status === 'IN_PROGRESS' || room?.status === 'FINISHED') ? 'Início confirmado pela Lobbito.' : '';
    notice('room-action-message', confirmed || 'Solicitação aceita pela Lobbito. Acompanhe o estado da sala.');
    void refreshAccount();
    void loadHistory();
  } catch (error) {
    if (handleAuth(error, version)) return;
    if (error.characterValidation && displayedRoom()?.id === id) {
      applyRoom({ ...displayedRoom(), characterValidation: error.characterValidation }, false);
    }
    notice('room-action-message', serverMessage(error), 'error');
  } finally {
    if (version === sessionVersion) {
      roomAction = undefined;
      showResult();
      renderSummary();
      if (needsRefresh) void checkRoom(id, true);
      else schedulePoll();
    }
  }
}

function renderHistory() {
  byId('refresh-history').disabled = !connected || historyBusy;
  byId('load-more').disabled = historyBusy;
  byId('load-more').hidden = !historyCursor;
  byId('room-table').hidden = !historyRooms.length;
  const message = !connected ? 'Conecte sua chave para consultar o histórico.'
    : historyBusy && !historyRooms.length ? 'Carregando salas…'
      : !historyRooms.length ? 'Nenhuma sala disponível no histórico.' : '';
  notice('history-message', message);
  byId('history-rows').replaceChildren(...historyRooms.map((room) => {
    const row = element('tr');
    const [label, kind] = statusInfo[room.status] ?? ['Status atualizado', ''];
    const status = element('span', label, 'pill');
    status.dataset.kind = kind;
    const statusCell = element('td');
    statusCell.append(status);
    const action = element('td');
    const button = element('button', 'Ver sala', 'button secondary');
    button.type = 'button';
    button.setAttribute('aria-label', `Ver sala ${room.name || room.roomId || room.id}`);
    button.addEventListener('click', () => void checkRoom(room.id));
    action.append(button);
    const outcome = resultWinner(room.result) ?? (room.result?.status === 'CONFIRMED' ? 'Confirmado' : room.result?.status === 'PENDING' ? 'Pendente' : '—');
    row.append(element('td', room.name || room.roomId || room.id), element('td', modeLabel(room.mode)), statusCell, element('td', outcome), element('td', date(room.createdAt)), action);
    return row;
  }));
}

async function loadHistory(append = false) {
  if (!connected || historyBusy || (append && !historyCursor)) return;
  const version = sessionVersion;
  const query = append ? `?cursor=${encodeURIComponent(historyCursor)}` : '';
  let failure;
  historyBusy = true;
  renderHistory();
  try {
    const history = await api(`/rooms${query}`);
    if (version !== sessionVersion) return;
    const rooms = append ? [...historyRooms, ...history.data] : history.data;
    historyRooms = [...new Map(rooms.map((room) => [room.id, room])).values()];
    historyCursor = history.nextCursor;
  } catch (error) {
    if (!handleAuth(error, version)) failure = serverMessage(error);
  } finally {
    if (version === sessionVersion) {
      historyBusy = false;
      renderHistory();
      if (failure) notice('history-message', failure, 'error');
    }
  }
}

function inboxOutcome(room) {
  return resultWinner(room.result) ?? (room.result?.status === 'CONFIRMED' ? 'Confirmado' : 'Pendente');
}

function renderInbox() {
  const list = inboxState?.data ?? [];
  byId('refresh-inbox').disabled = !connected || inboxLoading;
  byId('inbox-connection').hidden = !inboxState;
  byId('inbox-table').hidden = list.length === 0;
  if (inboxState) {
    rows('inbox-status', [
      ['Webhook', inboxState.configured ? 'Configurado no portal' : 'Aguardando configuração'],
      ['Conta Lobbito', inboxState.accountId],
      ['Último teste recebido', date(inboxState.lastTestAt)],
      ['Último resultado recebido', date(inboxState.lastResultAt)],
    ]);
    byId('inbox-url-field').hidden = !inboxState.url;
    if (byId('inbox-url').value !== (inboxState.url ?? '')) byId('inbox-url').value = inboxState.url ?? '';
    byId('inbox-config-help').textContent = inboxState.url
      ? 'Cadastre a URL no painel da Lobbito e configure o segredo do webhook na hospedagem do portal.'
      : 'A Lobbito precisa de uma URL pública HTTPS para entregar os resultados. A configuração fica na hospedagem do portal.';
  }
  const message = !connected ? 'Conecte sua chave para consultar os resultados recebidos.'
    : !inboxState ? 'Consultando a configuração dos resultados…'
      : !inboxState.configured ? 'A entrega direta de resultados ainda não foi ativada para esta conta.'
        : !list.length ? 'Nenhum resultado recebido por webhook.' : '';
  if (byId('inbox-message').textContent !== message) notice('inbox-message', message);
  byId('inbox-rows').replaceChildren(...list.map(({ room, receivedAt }) => {
    const row = element('tr');
    const action = element('td');
    const button = element('button', 'Ver resultado', 'button secondary');
    button.type = 'button';
    button.addEventListener('click', () => {
      applyRoom(room, true);
      byId('result').scrollIntoView({ block: 'nearest' });
      schedulePoll();
    });
    action.append(button);
    row.append(element('td', room.name || room.roomId || room.id), element('td', modeLabel(room.mode)),
      element('td', inboxOutcome(room)), element('td', date(receivedAt)), action);
    return row;
  }));
}

async function loadInbox() {
  if (!connected || inboxLoading) return;
  const version = sessionVersion;
  clearTimeout(inboxTimer);
  inboxLoading = true;
  byId('refresh-inbox').disabled = true;
  let delay = 10000;
  try {
    const fresh = await api('/results');
    if (version !== sessionVersion) return;
    const redraw = JSON.stringify(inboxState) !== JSON.stringify(fresh);
    inboxState = fresh;
    if (redraw || byId('inbox-message').dataset.kind === 'error') renderInbox();
    const selected = displayedRoom();
    const received = fresh.data.find(({ room }) => room.id === selected?.id)?.room;
    if (received && selected.result?.status !== 'CONFIRMED' && (received.result?.status === 'CONFIRMED' || selected.result?.status !== 'PENDING')) {
      applyRoom({ ...selected, status: received.status, result: received.result }, false);
      schedulePoll();
    }
  } catch (error) {
    delay = Math.max(delay, (error.retryAfter || 0) * 1000);
    if (!handleAuth(error, version)) notice('inbox-message', serverMessage(error), 'error');
  } finally {
    if (version === sessionVersion) {
      inboxLoading = false;
      byId('refresh-inbox').disabled = false;
      if (inboxState?.configured) inboxTimer = setTimeout(() => void loadInbox(), delay);
    }
  }
}

roomForm.addEventListener('change', (event) => {
  const input = event.target;
  if (input.name === 'family') {
    family = input.value;
    renderModes();
  } else if (input.name === 'mode') {
    mode = catalog.find((entry) => entry.id === input.value);
    renderModeFields();
  } else if (input.id === 'use-teams') byId('team-fields').hidden = !input.checked;
  renderSummary();
});
roomForm.addEventListener('input', renderSummary);
byId('character-search').addEventListener('input', filterCharacters);
byId('character-list').addEventListener('change', (event) => {
  const checkbox = event.target;
  const id = Number(checkbox.value);
  if (checkbox.checked) blockedCharacters.add(id);
  else blockedCharacters.delete(id);
  renderCharacterSelection();
});
byId('clear-characters').addEventListener('click', () => {
  blockedCharacters.clear();
  for (const checkbox of byId('character-list').querySelectorAll('input:checked')) checkbox.checked = false;
  renderCharacterSelection();
});
byId('retry-character-catalog').addEventListener('click', () => void loadModes());
byId('pet-search').addEventListener('input', filterPets);
byId('pet-rule-types').addEventListener('change', (event) => {
  petRule = event.target.value;
  byId('pet-search').value = '';
  renderPetPicker();
});
byId('pet-list').addEventListener('change', (event) => {
  const input = event.target;
  const selected = petSelections[family][petRule];
  const id = Number(input.value);
  if (input.checked) selected.add(id);
  else selected.delete(id);
  renderPetSelection();
});
byId('clear-pet-selection').addEventListener('click', () => {
  petSelections[family][petRule].clear();
  for (const input of byId('pet-list').querySelectorAll('input:checked')) input.checked = false;
  renderPetSelection();
});
roomForm.addEventListener('invalid', (event) => {
  const group = event.target.closest('details');
  if (group) group.open = true;
}, true);
byId('room-preset').addEventListener('change', (event) => {
  const preset = presets[event.target.value];
  if (!preset) return;
  family = preset.family;
  roomForm.querySelector(`[name="family"][value="${family}"]`).checked = true;
  renderModes(preset.mode);
  byId('deadline').value = preset.minutes;
  byId('rule-gloo').value = preset.gloo ?? '';
  byId('rule-headshots').value = preset.headshots ?? '';
  if (preset.capacity && [...byId('capacity').options].some(option => Number(option.value) === preset.capacity)) {
    byId('capacity').value = preset.capacity;
  }
  renderSummary();
});
roomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!connected) {
    notice('connection-message', 'Conecte sua chave para criar a sala.');
    byId('api-key').focus();
    return;
  }
  if (attempt?.pending || !mode) return;
  try {
    void sendRoom(formPayload());
  } catch (error) {
    notice('form-message', error.message, 'error');
  }
});
connectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = byId('api-key');
  const connect = byId('connect');
  connect.disabled = true;
  connect.textContent = 'Conectando…';
  notice('connection-message', '');
  try {
    const session = await api('/session', { method: 'POST', body: { key: key.value } });
    key.value = '';
    beginSession(session);
  } catch (error) {
    notice('connection-message', serverMessage(error), 'error');
  } finally {
    connect.disabled = false;
    connect.textContent = 'Conectar à API';
  }
});
byId('start-demo').addEventListener('click', async () => {
  if (connected || byId('connect').disabled) return;
  demo = createDemoApi(defaultModes);
  beginSession(await demo('/session'));
});
byId('disconnect').addEventListener('click', async () => {
  const disconnect = byId('disconnect');
  disconnect.disabled = true;
  try {
    await api('/session', { method: 'DELETE' });
    demo = undefined;
    resetSession();
    byId('room-password').value = '';
    renderSummary();
    byId('api-key').focus();
  } catch (error) {
    notice('connection-message', serverMessage(error), 'error');
  } finally {
    disconnect.disabled = false;
  }
});
byId('refresh-history').addEventListener('click', () => void loadHistory());
byId('load-more').addEventListener('click', () => void loadHistory(true));
byId('refresh-inbox').addEventListener('click', () => void loadInbox());
byId('copy-inbox-url').addEventListener('click', async () => {
  const field = byId('inbox-url');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    const button = byId('copy-inbox-url');
    button.textContent = 'URL copiada';
    setTimeout(() => { button.textContent = 'Copiar URL'; }, 2000);
  } catch {
    field.focus();
    field.select();
  }
});
byId('refresh-room').addEventListener('click', () => {
  const room = displayedRoom();
  if (room?.id) void checkRoom(room.id);
});
byId('retry-room').addEventListener('click', () => void sendRoom(undefined, true));
byId('close-pending').addEventListener('click', async () => {
  if (submitting || !attempt?.canClose) return;
  const version = sessionVersion;
  submitting = true;
  showResult();
  renderSummary();
  try {
    await api('/retry', { method: 'DELETE' });
    if (version !== sessionVersion) return;
    updateAttempt(undefined);
    notice('form-message', 'Pedido encerrado. Você pode criar outra sala.', 'success');
  } catch (error) {
    if (handleAuth(error, version)) return;
    notice('form-message', serverMessage(error), 'error');
    await recoverSessionAttempt();
  } finally {
    if (version === sessionVersion) {
      submitting = false;
      showResult();
      renderSummary();
    }
  }
});
byId('start-room').addEventListener('click', () => void manageRoom('start', displayedRoom()?.id));
byId('cancel-room').addEventListener('click', () => {
  const id = displayedRoom()?.id;
  const dialog = byId('cancel-dialog');
  if (!id || dialog.open) return;
  clearTimeout(pollTimer);
  dialog.dataset.roomId = id;
  dialog.showModal();
});
byId('cancel-dialog').addEventListener('submit', (event) => {
  event.preventDefault();
  const dialog = event.currentTarget;
  const id = dialog.dataset.roomId;
  dialog.close();
  if (event.submitter?.value === 'cancel') void manageRoom('cancel', id);
});
byId('cancel-dialog').addEventListener('close', () => schedulePoll());
byId('copy-room').addEventListener('click', async () => {
  const room = displayedRoom();
  if (!room?.roomId) return;
  const access = [`Sala Free Fire`, `ID da sala: ${room.roomId}`, room.password && `Senha: ${room.password}`, room.joinDeadline && `Entrada até: ${date(room.joinDeadline)}`].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(access);
    byId('result-message').textContent = 'Acesso copiado para a área de transferência.';
  } catch {
    byId('result-message').textContent = 'Selecione o ID e a senha abaixo para copiá-los.';
  }
});

function highlightNavigation() {
  const section = location.hash.slice(1) || 'nova-sala';
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === section) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', highlightNavigation);
highlightNavigation();
renderModes();
renderCharacterPicker();
byId('connect').disabled = true;
try {
  const session = await api('/session');
  if (session.connected) beginSession(session);
} catch (error) {
  notice('connection-message', serverMessage(error), 'error');
} finally {
  byId('connect').disabled = false;
}

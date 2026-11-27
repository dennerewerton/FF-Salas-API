import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from '../server.mjs';
import { openWebhooks } from '../lib/webhooks.mjs';

const testKey = 'lbt_live_cenario_de_teste';
const testKeyBeta = 'lbt_live_cenario_beta';
const accountData = {
  id: 'acct_test_owner',
  name: 'Conta de teste',
  plan: { name: 'Free', internalField: 'não enviar' },
  usage: { roomsRemaining: 8, roomsLimit: 10, activeRooms: 1, concurrentLimit: 2 },
  privateField: 'não enviar',
};
const readyRoom = {
  id: 'room_portal01',
  roomId: '012345',
  password: '046789',
  status: 'WAITING_PLAYERS',
  mode: '2x2',
  map: 'Bermuda',
  createdAt: '2026-11-26T22:30:00.000Z',
  joinDeadline: '2026-11-26T22:40:00.000Z',
  sensitiveField: 'não enviar',
};
const pending = { id: readyRoom.id, status: 'CREATION_UNKNOWN', mode: '2x2' };

function api(data, status = 200, headers) {
  return Response.json(data, { status, headers });
}

async function fixture(t, upstream, { authorize = () => true, ...options } = {}) {
  const calls = [];
  const server = createServer({
    ...options,
    async fetchApi(address, request) {
      const url = new URL(address);
      assert.equal(url.origin, 'https://api.lobbito.com.br');
      assert.equal(request.redirect, 'error');
      calls.push({ path: url.pathname, query: url.searchParams, ...request });
      if (url.pathname === '/v1/me') {
        const auth = request.headers.Authorization;
        const key = auth.slice('Bearer '.length);
        if (![testKey, testKeyBeta].includes(key) || !authorize(key)) {
          return api({ error: { code: 'unauthorized', message: 'conteúdo interno' } }, 401);
        }
        return api(auth.endsWith('_beta') ? { ...accountData, id: 'acct_test_beta', name: 'Conta Beta' } : accountData);
      }
      return upstream(url, request);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { body, cookie, method = 'GET', headers = {} } = {}) {
    if (body !== undefined) headers = { 'Content-Type': 'application/json', ...headers };
    if (cookie) headers = { Cookie: cookie, ...headers };
    const response = await fetch(`${origin}${path}`, {
      headers,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, data: response.status === 204 ? null : await response.json(), status: response.status };
  }

  async function login(key = testKey) {
    const result = await request('/api/session', { method: 'POST', body: { key } });
    assert.equal(result.status, 200);
    return { ...result, cookie: result.response.headers.get('Set-Cookie').split(';')[0] };
  }
  return { request, login, calls };
}

test('isola as contas, protege o cookie, valida a origem e encerra a sessão', async (t) => {
  const { request, login, calls } = await fixture(t, (url) => {
    assert.equal(url.pathname, '/v1/modes');
    return api({ error: { code: 'unauthorized' } }, 401);
  }, { secureCookies: true });
  const guest = await request('/api/session');
  assert.deepEqual(guest.data, { connected: false });
  assert.equal((await request('/api/rooms')).status, 401);
  const crossSite = await request('/api/session', {
    method: 'POST', body: { key: testKey }, headers: { Origin: 'https://exemplo.test' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(calls.length, 0);

  const invalid = await request('/api/session', { method: 'POST', body: { key: 'lbt_live_invalida' } });
  assert.equal(invalid.status, 401);
  assert.doesNotMatch(JSON.stringify(invalid.data), /conteúdo interno/);
  const alpha = await login();
  const beta = await login(testKeyBeta);
  assert.match(alpha.response.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=7200; Secure/);
  assert.equal(alpha.response.headers.get('Cache-Control'), 'no-store');
  assert.notEqual(alpha.cookie, beta.cookie);
  assert.deepEqual(alpha.data.account, { name: accountData.name, plan: { name: 'Free' }, usage: accountData.usage });
  assert.doesNotMatch(JSON.stringify(alpha.data), /lbt_live_|não enviar/);
  const betaStatus = await request('/api/session', { cookie: beta.cookie });
  assert.equal(betaStatus.data.account.name, 'Conta Beta');

  const logout = await request('/api/session', { method: 'DELETE', cookie: alpha.cookie });
  assert.match(logout.response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.deepEqual((await request('/api/session', { cookie: alpha.cookie })).data, { connected: false });
  assert.equal((await request('/api/account', { cookie: beta.cookie })).status, 200);
  assert.equal((await request('/api/modes', { cookie: beta.cookie })).status, 401);
  assert.deepEqual((await request('/api/session', { cookie: beta.cookie })).data, { connected: false });
});

test('oferece catálogo e histórico sem vazar campos e acompanha uma criação em conferência', async (t) => {
  const createCalls = [];
  const { request, login } = await fixture(t, (url, input) => {
    if (url.pathname === '/v1/modes') return api({
      modes: [{ id: '2x2', mapIds: [1, 5] }],
      maps: [{ id: 1, name: 'Bermuda' }, { mapId: 5, name: 'Kalahari', internal: 'não enviar' }],
    });
    if (url.pathname === '/v1/rooms' && input.method === 'POST') {
      createCalls.push(input);
      return createCalls.length === 1 ? api(pending, 202) : api(readyRoom, 201);
    }
    if (url.pathname === `/v1/rooms/${readyRoom.id}`) return api(readyRoom);
    assert.equal(url.searchParams.get('cursor'), 'a&b=5');
    assert.equal(url.searchParams.get('limit'), '20');
    return api({ data: [readyRoom, { ...readyRoom, id: 'room_unrecognized', status: 'internal_worker_state' }], hasMore: true, nextCursor: 'seguinte' });
  });
  const { cookie } = await login();
  const modes = (await request('/api/modes', { cookie })).data.modes;
  assert.equal(modes.length, 7);
  assert.deepEqual(modes.find((item) => item.id === '2x2').maps, [{ id: 1, name: 'Bermuda' }, { id: 5, name: 'Kalahari' }]);

  const roomRequest = { mode: '2x2', password: '0123', mapId: 1, joinTimeoutMinutes: 12, unrelated: 'não enviar' };
  const created = await request('/api/rooms', { method: 'POST', cookie, body: roomRequest });
  assert.equal(created.status, 202);
  assert.equal(created.data.room.status, 'CREATION_UNKNOWN');
  assert.equal(created.data.room.roomId, null);
  assert.deepEqual(JSON.parse(createCalls[0].body), { mode: '2x2', password: '0123', mapId: 1, joinTimeoutMinutes: 12 });
  assert.match(createCalls[0].headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  assert.equal((await request('/api/session', { cookie })).data.attempt.pending, true);
  assert.equal((await request('/api/rooms', { method: 'POST', cookie, body: roomRequest })).status, 409);

  const room = (await request(`/api/rooms/${readyRoom.id}`, { cookie })).data;
  assert.equal(room.roomId, '012345');
  assert.equal(room.password, '046789');
  assert.equal((await request('/api/session', { cookie })).data.attempt.pending, false);
  assert.equal((await request('/api/rooms', { method: 'POST', cookie, body: roomRequest })).status, 201);
  assert.notEqual(createCalls[1].headers['Idempotency-Key'], createCalls[0].headers['Idempotency-Key']);

  const rooms = (await request('/api/rooms?cursor=a%26b%3D5', { cookie })).data;
  assert.deepEqual(rooms.data[0], { ...room, password: null });
  assert.equal(rooms.data[1].status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(rooms), /046789|internal_worker_state/);
  assert.equal(rooms.nextCursor, 'seguinte');
  assert.equal(Object.hasOwn(room, 'sensitiveField'), false);
});

test('retoma timeout e limite transitório com a mesma chave e a mesma configuração', async (t) => {
  const submissions = [];
  const { request, login } = await fixture(t, (url, input) => {
    assert.equal(url.pathname, '/v1/rooms');
    submissions.push(input);
    if (submissions.length === 1) throw new Error('detalhe de transporte que não pode aparecer');
    if (submissions.length === 2) return api({ error: { code: 'rate_limited', message: 'detalhe privado' } }, 429, { 'Retry-After': '4' });
    return api(readyRoom);
  });
  const { cookie } = await login();
  const body = { mode: '2x2', reference: 'treino' };
  const failed = await request('/api/rooms', { method: 'POST', cookie, body });
  assert.equal(failed.status, 502);
  assert.equal(failed.data.error.code, 'connection_error');
  assert.doesNotMatch(JSON.stringify(failed.data), /detalhe/);
  const attempt = (await request('/api/session', { cookie })).data.attempt;
  assert.equal(attempt.pending, true);
  assert.equal(attempt.room, undefined);
  assert.equal(Object.hasOwn(attempt, 'payload'), false);
  const retry = await request('/api/retry', { method: 'POST', cookie });
  assert.equal(retry.status, 429);
  assert.equal(retry.response.headers.get('Retry-After'), '4');
  assert.doesNotMatch(JSON.stringify(retry.data), /detalhe/);
  assert.equal((await request('/api/session', { cookie })).data.attempt.pending, true);
  const confirmed = await request('/api/retry', { method: 'POST', cookie });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.room.id, readyRoom.id);
  assert.equal(new Set(submissions.map((input) => input.headers['Idempotency-Key'])).size, 1);
  assert.equal(new Set(submissions.map((input) => input.body)).size, 1);
});

test('impede criações simultâneas da mesma sessão e libera novo pedido após falha confirmada', async (t) => {
  let release;
  let started;
  const waiting = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const submissions = [];
  const { request, login } = await fixture(t, async (_url, input) => {
    submissions.push(input);
    if (submissions.length === 1) {
      started();
      await waiting;
      return api({ error: { code: 'creation_failed' }, room: { ...pending, status: 'FAILED' } }, 503);
    }
    return api(readyRoom, 201);
  });
  const { cookie } = await login();
  const body = { mode: '2x2' };
  const creating = request('/api/rooms', { method: 'POST', cookie, body });
  try {
    await entered;
    assert.equal((await request('/api/session', { cookie })).data.attempt.inFlight, true);
    assert.equal((await request('/api/rooms', { method: 'POST', cookie, body })).status, 409);
    assert.equal((await request('/api/retry', { method: 'POST', cookie })).status, 409);
  } finally {
    release();
  }
  const failed = await creating;
  assert.equal(failed.data.error.code, 'creation_failed');
  assert.equal(failed.data.room.status, 'FAILED');
  assert.equal((await request('/api/session', { cookie })).data.attempt.pending, false);
  assert.equal((await request('/api/rooms', { method: 'POST', cookie, body })).status, 201);
  assert.notEqual(submissions[0].headers['Idempotency-Key'], submissions[1].headers['Idempotency-Key']);
});

test('valida senha, prazo, equipes, capacidade e regras antes de consumir chamadas', async (t) => {
  let lastPayload;
  const { request, login, calls } = await fixture(t, (_url, input) => {
    lastPayload = JSON.parse(input.body);
    return api(readyRoom, 201);
  });
  const { cookie } = await login();
  const create = (body) => request('/api/rooms', { method: 'POST', cookie, body });
  const invalid = [
    { password: '123' }, { joinTimeoutMinutes: 65 }, { autoStart: true },
    { teams: { A: ['111', '222'], B: ['222', '333'] } }, { settings: { unknown: true } },
    { mode: 'br-squad', maxPlayers: 50 }, { mode: 'br-duo', maxPlayers: 12, settings: { infiniteGloo: true } },
    { mode: 'br-squad', maxPlayers: 8, teams: { T1: ['111'], T3: ['222'] } },
  ];
  for (const input of invalid) assert.equal((await create({ mode: '2x2', ...input })).status, 400);
  assert.equal(calls.length, 1);

  const teams = { T1: ['111111111'], T2: ['222222222', '333333333'] };
  assert.equal((await create({ mode: 'br-duo', maxPlayers: 12, teams, autoStart: true })).status, 201);
  assert.deepEqual(lastPayload, { mode: 'br-duo', maxPlayers: 12, teams, autoStart: true });
  const cs = { mode: '1x1', settings: { infiniteGloo: true, headshotsOnly: false } };
  assert.equal((await create(cs)).status, 201);
  assert.deepEqual(lastPayload, cs);
});

test('expõe o catálogo de personagens e encaminha a restrição em Contra Squad e Battle Royale', async (t) => {
  const submissions = [];
  const { request, login } = await fixture(t, (url, input) => {
    if (url.pathname === '/v1/modes') return api({ settings: {
      characters: [
        { id: 101, name: 'Personagem A', internal: 'DADO_INTERNO' },
        { id: 202, name: 'Personagem B' }, { id: 101, name: 'Duplicado' },
        { id: 'id-inválido', name: 'Ocultar' }, { id: 303, name: '  ' },
      ],
      privateRules: 'DADO_INTERNO',
    } });
    assert.equal(url.pathname, '/v1/rooms');
    submissions.push(JSON.parse(input.body));
    return api(readyRoom, 201);
  });
  const { cookie } = await login();
  const modes = await request('/api/modes', { cookie });
  assert.deepEqual(modes.data.characters, [{ id: 101, name: 'Personagem A' }, { id: 202, name: 'Personagem B' }]);
  assert.deepEqual(modes.data.petCatalogs, { cs: { pets: [], petSkills: [] }, br: { pets: [], petSkills: [] } });
  assert.doesNotMatch(JSON.stringify(modes.data), /DADO_INTERNO|Duplicado|Ocultar/);

  const create = (body) => request('/api/rooms', { method: 'POST', cookie, body });
  const cs = { mode: '2x2', settings: { headshotsOnly: true, allowedCharacterIds: [101, 202] } };
  const br = { mode: 'br-squad', maxPlayers: 12, settings: { allowedCharacterIds: [202] } };
  const unrestricted = { mode: 'br-duo', maxPlayers: 8, settings: { allowedCharacterIds: [] } };
  for (const payload of [cs, br, unrestricted]) assert.equal((await create(payload)).status, 201);
  assert.deepEqual(submissions, [cs, br, unrestricted]);

  for (const allowedCharacterIds of [null, '101', [101, 101], ['101'], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.equal((await create({ mode: '2x2', settings: { allowedCharacterIds } })).status, 400);
  }
  assert.equal((await create({ ...br, settings: { ...br.settings, headshotsOnly: true } })).status, 400);
  assert.equal((await create({ mode: '2x2', settings: { allowedPetIds: [1] } })).status, 400);
  assert.equal(submissions.length, 3);
});

test('oferece catálogos de pets por modo e encaminha regras de pet e habilidade separadamente', async (t) => {
  const submissions = [];
  const { request, login } = await fixture(t, (url, input) => {
    if (url.pathname === '/v1/modes') return api({
      settings: {
        pets: [{ id: 101, name: 'Pet de CS', raw: 'DADO_INTERNO' }, { id: 101, name: 'Duplicado' }],
        petSkills: [{ id: 201, name: 'Habilidade de CS', raw: 'DADO_INTERNO' }],
      },
      settingsByGameMode: {
        battle_royale: {
          pets: [{ id: 102, name: 'Pet de BR' }, { id: 'inválido', name: 'Ocultar' }],
        },
      },
    });
    assert.equal(url.pathname, '/v1/rooms');
    submissions.push(JSON.parse(input.body));
    return api(readyRoom, 201);
  });
  const { cookie } = await login();
  const modes = await request('/api/modes', { cookie });
  assert.equal(modes.status, 200);
  assert.deepEqual(modes.data.petCatalogs, {
    cs: { pets: [{ id: 101, name: 'Pet de CS' }], petSkills: [{ id: 201, name: 'Habilidade de CS' }] },
    br: { pets: [{ id: 102, name: 'Pet de BR' }], petSkills: [] },
  });
  assert.doesNotMatch(JSON.stringify(modes.data), /DADO_INTERNO|Duplicado|Ocultar/);

  const create = (body) => request('/api/rooms', { method: 'POST', cookie, body });
  const cs = { mode: '1x1', settings: { blockedPetIds: [101], blockedPetSkillIds: [201], headshotsOnly: true } };
  const br = { mode: 'br-squad', maxPlayers: 12, settings: { blockedPetIds: [102], blockedPetSkillIds: [202] } };
  const skillOnly = { mode: 'br-duo', maxPlayers: 8, settings: { blockedPetSkillIds: [202] } };
  const unrestricted = { mode: '2x2', settings: { blockedPetIds: [], blockedPetSkillIds: [] } };
  for (const payload of [cs, br, skillOnly, unrestricted]) assert.equal((await create(payload)).status, 201);
  assert.deepEqual(submissions, [cs, br, skillOnly, unrestricted]);

  for (const setting of ['blockedPetIds', 'blockedPetSkillIds']) {
    for (const invalid of [null, [101, 101], ['101'], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      assert.equal((await create({ mode: '2x2', settings: { [setting]: invalid } })).status, 400);
    }
  }
  assert.equal(submissions.length, 4);
});

test('consulta a conferência da própria sala e sanitiza os detalhes de bloqueios no início', async (t) => {
  let failures = 0;
  const checkedAt = '2026-11-26T22:30:00.000Z';
  const invalidValidation = {
    status: 'INVALID', checkedAt, internalCapture: 'DADO_INTERNO',
    violations: [
      { accountId: '00123456', characterId: 202, characterName: 'Personagem B', reason: 'NOT_ALLOWED', capture: 'DADO_INTERNO' },
      { accountId: 654321, reason: 'UNKNOWN_CHARACTER' },
      { accountId: 654321, reason: 'DADO_INTERNO' },
      { accountId: 'DADO_INTERNO', reason: 'NOT_ALLOWED' },
    ],
  };
  const expected = { status: 'INVALID', checkedAt, violations: [
    { accountId: '00123456', characterId: 202, characterName: 'Personagem B', reason: 'NOT_ALLOWED' },
    { accountId: '654321', characterId: null, characterName: null, reason: 'UNKNOWN_CHARACTER' },
  ] };
  const room = { ...readyRoom, characterValidation: invalidValidation };
  const { request, login } = await fixture(t, (url, input) => {
    if (input.headers.Authorization === `Bearer ${testKeyBeta}`) return api({ error: { code: 'not_found' } }, 404);
    if (url.pathname === '/v1/rooms' && input.method === 'GET') return api({ data: [room] });
    if (url.pathname.endsWith('/cancel')) return api({ error: {
      code: 'characters_not_allowed', message: 'DADO_INTERNO', details: { characterValidation: invalidValidation },
    } }, 409);
    if (url.pathname.endsWith('/start')) {
      failures++;
      const characterValidation = failures === 1 ? invalidValidation : { status: 'UNAVAILABLE', checkedAt: 'DADO_INTERNO' };
      const code = failures === 1 ? 'characters_not_allowed' : 'character_validation_unavailable';
      return api({ error: { code, message: 'DADO_INTERNO', details: { characterValidation, raw: 'DADO_INTERNO' } } }, 409);
    }
    if (input.method === 'POST') return api({ ...room, characterValidation: { status: 'PENDING' } }, 201);
    return api(room);
  });
  const { cookie } = await login();
  const beta = await login(testKeyBeta);
  const path = `/api/rooms/${room.id}`;
  assert.equal((await request(path, { cookie: beta.cookie })).status, 404);
  const created = await request('/api/rooms', { method: 'POST', cookie, body: { mode: '2x2', settings: { allowedCharacterIds: [101] } } });
  assert.deepEqual(created.data.room.characterValidation, { status: 'PENDING', checkedAt: null, violations: [] });
  assert.deepEqual((await request(path, { cookie })).data.characterValidation, expected);
  assert.equal(Object.hasOwn((await request('/api/rooms', { cookie })).data.data[0], 'characterValidation'), false);

  const denied = await request(`${path}/start`, { method: 'POST', cookie });
  assert.equal(denied.status, 409);
  assert.equal(denied.data.error.code, 'characters_not_allowed');
  assert.deepEqual(denied.data.error.details, { characterValidation: expected });
  assert.doesNotMatch(JSON.stringify(denied.data), /DADO_INTERNO/);
  const unavailable = await request(`${path}/start`, { method: 'POST', cookie });
  assert.equal(unavailable.data.error.code, 'character_validation_unavailable');
  assert.deepEqual(unavailable.data.error.details.characterValidation, { status: 'UNAVAILABLE', checkedAt: null, violations: [] });
  const cancel = await request(`${path}/cancel`, { method: 'POST', cookie });
  assert.equal(cancel.status, 409);
  assert.equal(cancel.data.error.code, 'invalid_state');
  assert.equal(cancel.data.error.details, undefined);
});

test('sanitiza conflitos de pet equipado e de habilidade de pet na conferência e no início', async (t) => {
  const checkedAt = '2026-11-26T22:30:00.000Z';
  const characterValidation = { status: 'INVALID', checkedAt, violations: [
    { accountId: '00123456', petId: 101, petName: 'Pet equipado', petSkillName: 'DADO_INTERNO', reason: 'PET_NOT_ALLOWED' },
    { accountId: '00123456', petSkillId: 201, petSkillName: 'Habilidade equipada', petName: 'DADO_INTERNO', reason: 'PET_SKILL_NOT_ALLOWED' },
    { accountId: 'DADO_INTERNO', petSkillId: 202, reason: 'PET_SKILL_NOT_ALLOWED' },
  ] };
  const expected = { status: 'INVALID', checkedAt, violations: [
    { accountId: '00123456', petId: 101, petName: 'Pet equipado', reason: 'PET_NOT_ALLOWED' },
    { accountId: '00123456', petSkillId: 201, petSkillName: 'Habilidade equipada', reason: 'PET_SKILL_NOT_ALLOWED' },
  ] };
  const room = { ...readyRoom, characterValidation };
  const { request, login } = await fixture(t, (url) => {
    if (url.pathname === '/v1/rooms') return api({ data: [room] });
    if (url.pathname.endsWith('/start')) return api({ error: {
      code: 'pets_not_allowed', message: 'DADO_INTERNO', details: { characterValidation, raw: 'DADO_INTERNO' },
    } }, 409);
    return api(room);
  });
  const { cookie } = await login();
  const path = `/api/rooms/${room.id}`;
  assert.deepEqual((await request(path, { cookie })).data.characterValidation, expected);
  assert.equal(Object.hasOwn((await request('/api/rooms', { cookie })).data.data[0], 'characterValidation'), false);

  const denied = await request(`${path}/start`, { method: 'POST', cookie });
  assert.equal(denied.status, 409);
  assert.equal(denied.data.error.code, 'pets_not_allowed');
  assert.deepEqual(denied.data.error.details, { characterValidation: expected });
  assert.doesNotMatch(JSON.stringify(denied.data), /DADO_INTERNO/);
});

test('inicia ou cancela na Lobbito com a chave da sessão e consulta a sala quando necessário', async (t) => {
  const roomPath = `/v1/rooms/${readyRoom.id}`;
  const { request, login, calls } = await fixture(t, (url, input) => {
    assert.equal(input.headers.Authorization, `Bearer ${testKey}`);
    assert.equal(input.body, undefined);
    assert.equal(input.headers['Idempotency-Key'], undefined);
    if (url.pathname === `${roomPath}/start`) {
      assert.equal(input.method, 'POST');
      return api({ room: { ...readyRoom, status: 'IN_PROGRESS', autoResult: true } });
    }
    if (url.pathname === `${roomPath}/cancel`) {
      assert.equal(input.method, 'POST');
      return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, roomPath);
    assert.equal(input.method, 'GET');
    return api({ ...readyRoom, status: 'CANCELLED' });
  });
  const { cookie } = await login();
  const start = await request(`/api/rooms/${readyRoom.id}/start`, { method: 'POST', cookie });
  assert.equal(start.status, 200);
  assert.equal(start.data.room.status, 'IN_PROGRESS');
  assert.equal(start.data.room.password, null);
  assert.equal(start.data.room.autoResult, true);
  const cancel = await request(`/api/rooms/${readyRoom.id}/cancel`, { method: 'POST', cookie });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.room.status, 'CANCELLED');
  assert.deepEqual(calls.slice(1).map(({ path, method }) => [method, path]), [
    ['POST', `${roomPath}/start`], ['POST', `${roomPath}/cancel`], ['GET', roomPath],
  ]);
});

test('protege as ações de sala e traduz erros sem expor a resposta interna', async (t) => {
  const { request, login, calls } = await fixture(t, (url) => {
    if (url.pathname.endsWith('/start')) {
      return api({ error: { code: 'invalid_state', message: 'detalhe interno' } }, 409);
    }
    return api({ error: { code: 'not_found', message: 'ID de outra conta' } }, 404);
  });
  const startPath = `/api/rooms/${readyRoom.id}/start`;
  const cancelPath = `/api/rooms/${readyRoom.id}/cancel`;
  assert.equal((await request(startPath, { method: 'POST' })).status, 401);
  const { cookie } = await login();
  const foreignOrigin = await request(cancelPath, { method: 'POST', cookie, headers: { Origin: 'https://outro.test' } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await request(startPath, { cookie })).status, 404);
  assert.equal((await request('/api/rooms/room%2Foutra/start', { method: 'POST', cookie })).status, 404);
  assert.equal(calls.length, 1);
  const wrongState = await request(startPath, { method: 'POST', cookie });
  assert.equal(wrongState.status, 409);
  assert.equal(wrongState.data.error.code, 'invalid_state');
  assert.doesNotMatch(JSON.stringify(wrongState.data), /detalhe interno/);
  const missing = await request(cancelPath, { method: 'POST', cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'not_found');
  assert.doesNotMatch(JSON.stringify(missing.data), /ID de outra conta/);
});

test('mantém a ação aceita sem consulta disponível e não repete ação de efeito incerto', async (t) => {
  const { request, login, calls } = await fixture(t, (url) => {
    if (url.pathname.endsWith('/start')) return api({ accepted: true }, 202);
    if (url.pathname.endsWith('/cancel')) throw new Error('erro de transporte privado');
    return api({ error: { code: 'rate_limited' } }, 429);
  });
  const { cookie } = await login();
  const path = `/api/rooms/${readyRoom.id}`;
  const started = await request(`${path}/start`, { method: 'POST', cookie });
  assert.equal(started.status, 202);
  assert.deepEqual(started.data, { room: null });
  const uncertain = await request(`${path}/cancel`, { method: 'POST', cookie });
  assert.equal(uncertain.status, 502);
  assert.equal(uncertain.data.error.code, 'action_unconfirmed');
  assert.match(uncertain.data.error.message, /Consulte o status da sala/);
  assert.doesNotMatch(JSON.stringify(uncertain.data), /privado/);
  assert.deepEqual(calls.slice(1).map(({ method }) => method), ['POST', 'GET', 'POST']);
});

test('exibe somente resultados confirmados da conta e preserva zeros e dados ausentes', async (t) => {
  const cs = {
    ...readyRoom, status: 'FINISHED', autoResult: true,
    result: {
      status: 'CONFIRMED', source: 'AUTO', winner: 'A', matchId: 'interno', evidence: 'NATIVE_MATCH',
      stats: {
        123456: { kills: 0, deaths: 2, damage: 0, privateField: 'interno' },
        987654: { kills: 2, team: 'A' },
      },
    },
  };
  const br = {
    ...readyRoom, id: 'room_royale', mode: 'br-duo', status: 'FINISHED', autoResult: true,
    result: {
      status: 'CONFIRMED', source: 'AUTO', winnerTeamId: 7, careerSignal: 'interno',
      players: [{ accountId: '000009', teamId: 7, kills: 0 }, { accountId: 543210, teamId: 8, kills: 1, damage: 220.5 }],
      teams: [{ teamId: 7, placement: 1 }, { teamId: 8, place: 2 }],
    },
  };
  const waiting = {
    ...readyRoom, id: 'room_conferencia', status: 'FINISHED', autoResult: false,
    result: { ...cs.result, status: 'PENDING', careerSignal: { winner: 'B', players: [{ kills: 10 }] } },
  };
  const { request, login } = await fixture(t, (url, input) => {
    const listed = url.pathname === '/v1/rooms';
    if (input.headers.Authorization === `Bearer ${testKeyBeta}`) {
      return listed ? api({ data: [], hasMore: false }) : api({ error: { code: 'not_found' } }, 404);
    }
    return listed ? api({ data: [cs, br, waiting] }) : api(cs);
  });
  const primary = await login();
  const secondary = await login(testKeyBeta);
  const list = await request('/api/rooms', { cookie: primary.cookie });
  assert.equal(list.status, 200);
  const [first, second, third] = list.data.data;
  assert.equal(first.autoResult, true);
  assert.deepEqual(first.result, {
    status: 'CONFIRMED', source: 'AUTO', winner: 'A', winnerTeamId: null,
    players: [
      { accountId: '123456', teamId: null, kills: 0, deaths: 2, damage: 0 },
      { accountId: '987654', teamId: 'A', kills: 2, deaths: null, damage: null },
    ],
    teams: [],
  });
  assert.deepEqual(second.result, {
    status: 'CONFIRMED', source: 'AUTO', winner: null, winnerTeamId: '7',
    players: [
      { accountId: '000009', teamId: '7', kills: 0, deaths: null, damage: null },
      { accountId: '543210', teamId: '8', kills: 1, deaths: null, damage: 220.5 },
    ],
    teams: [{ teamId: '7', placement: 1 }, { teamId: '8', placement: 2 }],
  });
  assert.equal(third.autoResult, false);
  assert.deepEqual(third.result, { status: 'PENDING', source: null, winner: null, winnerTeamId: null, players: [], teams: [] });
  assert.doesNotMatch(JSON.stringify(list.data), /careerSignal|NATIVE_MATCH|interno|matchId/);
  const matchPath = `/api/rooms/${cs.id}`;
  assert.deepEqual((await request(matchPath, { cookie: primary.cookie })).data, first);
  assert.equal((await request(matchPath, { cookie: secondary.cookie })).status, 404);
  assert.deepEqual((await request('/api/rooms', { cookie: secondary.cookie })).data.data, []);
});

test('recebe webhook sem sessão e libera os resultados apenas à conta vinculada com chave válida', async (t) => {
  const secret = 'whsec_somente_fixture_resultados';
  const website = 'https://portal.exemplo.test';
  let keyRevoked = false;
  const webhooks = await openWebhooks({ secrets: new Map([[accountData.id, secret]]), databasePath: ':memory:' });
  const { request, login, calls } = await fixture(t, (url) => {
    return url.pathname === '/v1/rooms' ? api({ data: [readyRoom] }) : api(readyRoom);
  }, { webhooks, allowedOrigin: website, authorize: (key) => key !== testKey || !keyRevoked });
  const path = `/webhooks/lobbito/${accountData.id}`;
  const callback = {
    id: 'evt_test_result_delivery', type: 'room.finished', createdAt: new Date().toISOString(),
    data: { ...readyRoom, status: 'FINISHED', result: { status: 'CONFIRMED', winner: 'A', source: 'AUTO' } },
  };
  const time = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${time}.${JSON.stringify(callback)}`).digest('hex');
  const headers = { 'X-Lobbito-Signature': `t=${time},v1=${digest}`, 'X-Lobbito-Delivery': callback.id, 'X-Lobbito-Event': callback.type };

  assert.equal((await request(path, { method: 'POST', body: { ...callback, id: 'evt_tampered' }, headers })).status, 401);
  assert.equal((await request(path, { method: 'POST', body: callback, headers })).status, 204);
  assert.equal((await request(path, { method: 'POST', body: callback, headers })).status, 204);
  assert.equal((await request('/api/results')).status, 401);
  assert.equal(calls.length, 0);

  const primary = await login();
  const secondary = await login(testKeyBeta);
  const inbox = (await request('/api/results', { cookie: primary.cookie })).data;
  assert.equal(inbox.configured, true);
  assert.equal(inbox.url, `${website}${path}`);
  assert.ok(inbox.lastResultAt);
  assert.equal(inbox.data.length, 1);
  assert.equal(inbox.data[0].room.result.winner, 'A');
  assert.doesNotMatch(JSON.stringify(inbox), /046789|whsec_|lbt_live_/);
  assert.deepEqual((await request('/api/results', { cookie: secondary.cookie })).data.data, []);

  const match = (await request(`/api/rooms/${readyRoom.id}`, { cookie: primary.cookie })).data;
  assert.equal(match.status, 'FINISHED');
  assert.equal(match.result.status, 'CONFIRMED');
  assert.equal(match.password, null);
  assert.equal((await request('/api/rooms', { cookie: primary.cookie })).data.data[0].result.winner, 'A');
  assert.equal((await request(`/api/rooms/${readyRoom.id}`, { cookie: secondary.cookie })).data.result, null);

  keyRevoked = true;
  const revoked = await request('/api/results', { cookie: primary.cookie });
  assert.equal(revoked.status, 401);
  assert.equal(Object.hasOwn(revoked.data, 'data'), false);
  assert.deepEqual((await request('/api/session', { cookie: primary.cookie })).data, { connected: false });
});

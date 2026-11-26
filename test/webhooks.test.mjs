import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openWebhooks } from '../lib/webhooks.mjs';

const alpha = 'acct_alpha';
const beta = 'acct_beta';
const alphaSecret = 'whsec_ficticio_alpha';
const betaSecret = 'whsec_ficticio_beta';
const start = Date.parse('2026-10-25T18:24:02.000Z');
const roomId = 'room_webhook';
const keys = new Map([[alpha, alphaSecret], [beta, betaSecret]]);

function sign(raw, secret = alphaSecret, clock = start) {
  const timestamp = Math.floor(clock / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function resultEvent(id, at, status = 'CONFIRMED', options = {}) {
  const type = status === 'CONFIRMED' ? 'room.finished' : 'room.result_pending';
  return { id, type, createdAt: new Date(at).toISOString(), data: {
    id: roomId, status: 'FINISHED',
    result: { status, source: 'AUTO', winner: 'A' },
    ...options,
  } };
}

async function memory(t) {
  let time = start;
  const store = await openWebhooks({ secrets: keys, databasePath: ':memory:', now: () => time });
  t.after(() => store.close());
  const receive = (event, account = alpha, secret = alphaSecret, headers) => {
    const raw = Buffer.from(JSON.stringify(event));
    store.receive(account, sign(raw, secret, time), raw, headers);
  };
  return { store, receive, advance: (ms) => { time += ms; return time; } };
}

test('confere assinatura dos bytes crus, validade no relógio e os cabeçalhos auxiliares', async (t) => {
  const { store } = await memory(t);
  const body = resultEvent('evt_assinado', start, 'CONFIRMED', { name: 'Evento São Paulo' });
  const raw = Buffer.from(JSON.stringify(body, null, 2));
  const signature = sign(raw);
  assert.throws(() => store.receive(alpha, signature, Buffer.from(JSON.stringify(body))), { status: 401, code: 'invalid_webhook_signature' });
  assert.throws(() => store.receive(alpha, sign(raw, betaSecret), raw), { status: 401, code: 'invalid_webhook_signature' });
  assert.throws(() => store.receive(alpha, sign(raw, alphaSecret, start - 301_000), raw), { status: 401 });
  assert.throws(() => store.receive(alpha, sign(raw, alphaSecret, start + 301_000), raw), { status: 401 });
  assert.throws(() => store.receive(alpha, 't=,v1=abc', raw), { status: 401 });
  assert.throws(() => store.receive(alpha, signature, raw.toString()), { status: 401 });
  assert.throws(() => store.receive(alpha, signature, raw, { event: 'room.ready' }), { status: 400, code: 'invalid_webhook_payload' });
  assert.throws(() => store.receive(alpha, signature, raw, { delivery: 'evt_outro' }), { status: 400, code: 'invalid_webhook_payload' });
  assert.deepEqual(store.list(alpha), []);

  const boundary = sign(raw, alphaSecret, start - 300_000);
  store.receive(alpha, boundary, raw, { event: body.type, delivery: body.id });
  assert.equal(store.getRoom(alpha, roomId).name, 'Evento São Paulo');
});

test('ignora tipos irrelevantes e recusa formatos reconhecidos sem um resultado válido', async (t) => {
  const { store, receive } = await memory(t);
  receive({ id: 'evt_ready', type: 'room.ready', data: { password: '987654' } });
  const result = resultEvent('evt_finish', start);
  const invalid = [
    { ...result, id: '../evt_finish' },
    { ...result, createdAt: 'ontem' },
    { ...result, data: { ...result.data, id: 'room/finish' } },
    { ...result, data: { ...result.data, result: { status: 'CONFIRMED' } } },
    { ...result, data: { ...result.data, result: { status: 'PENDING' } } },
    { id: 'evt_test', type: 'webhook.test', createdAt: result.createdAt, data: null },
  ];
  for (const event of invalid) assert.throws(() => receive(event), { status: 400, code: 'invalid_webhook_payload' });
  const raw = Buffer.from('não é JSON');
  assert.throws(() => store.receive(alpha, sign(raw), raw), { status: 400, code: 'invalid_webhook_payload' });
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  assert.throws(() => store.receive(alpha, sign(invalidUtf8), invalidUtf8), { status: 400, code: 'invalid_webhook_payload' });
  assert.deepEqual(store.getStatus(alpha), { lastTestAt: null, lastResultAt: null });
  assert.equal(store.getRoom(alpha, roomId), null);
});

test('deduplica por conta e atualiza o estado de recebimento sem misturar tenants', async (t) => {
  const { store, receive, advance } = await memory(t);
  const health = { id: 'evt_health', type: 'webhook.test', createdAt: new Date(start).toISOString(), data: { message: 'Funcionando' } };
  receive(health);
  advance(1_000);
  receive(health);
  assert.deepEqual(store.getStatus(alpha), { lastTestAt: new Date(start).toISOString(), lastResultAt: null });
  assert.equal(store.hasAccount('acct_unknown'), false);
  assert.throws(() => receive(health, 'acct_unknown'), { status: 404, code: 'webhook_not_found' });
  assert.throws(() => receive(health, beta), { status: 401 });
  assert.deepEqual(store.getStatus(beta), { lastTestAt: null, lastResultAt: null });

  const event = resultEvent('evt_shared', start, 'CONFIRMED', { mode: '4x4', password: '987654' });
  receive(event);
  const receivedAt = new Date(advance(1_000)).toISOString();
  receive(event);
  receive({ ...event, data: { ...event.data, mode: '1x1' } }, beta, betaSecret);
  assert.equal(store.getRoom(alpha, roomId).mode, '4x4');
  assert.equal(store.getRoom(beta, roomId).mode, '1x1');
  assert.equal(store.getRoom('acct_unknown', roomId), null);
  assert.equal(store.list(alpha)[0].room.password, null);
  assert.equal(store.list(alpha)[0].type, 'room.finished');
  assert.equal(store.list(beta)[0].receivedAt, receivedAt);
  assert.deepEqual(store.getStatus(beta), { lastTestAt: null, lastResultAt: receivedAt });
  assert.notEqual(store.getStatus(alpha).lastResultAt, receivedAt);
});

test('usa a ordem do provedor com desempate estável e protege um confirmado de pendências tardias', async (t) => {
  const { store, receive, advance } = await memory(t);
  receive(resultEvent('evt_pendente', start + 2000, 'PENDING', {
    result: { status: 'PENDING', winner: 'B', careerSignal: { winner: 'B', players: [{ kills: 5 }] } },
  }));
  assert.equal(store.getRoom(alpha, roomId).result.winner, null);
  advance(1000);
  receive(resultEvent('evt_confirmado', start + 1000, 'CONFIRMED', {
    result: { status: 'CONFIRMED', winnerTeamId: 16, players: [{ accountId: 123, kills: 0 }], evidence: 'NATIVE_MATCH' },
  }));
  assert.deepEqual(store.getRoom(alpha, roomId).result.players, [
    { accountId: '123', teamId: null, kills: 0, deaths: null, damage: null },
  ]);
  assert.equal(store.getRoom(alpha, roomId).result.winnerTeamId, '16');
  assert.doesNotMatch(JSON.stringify(store.list(alpha)), /NATIVE_MATCH|careerSignal/);
  advance(1000);
  receive(resultEvent('evt_pendente_tarde', start + 5000, 'PENDING'));
  assert.equal(store.getRoom(alpha, roomId).result.winnerTeamId, '16');

  const terminal = resultEvent('evt_z', start + 6000, 'CONFIRMED', { result: { status: 'CONFIRMED', winner: 'B' } });
  receive(terminal);
  advance(1000);
  receive(resultEvent('evt_older', start + 5500));
  receive(resultEvent('evt_a', start + 6000));
  assert.equal(store.getRoom(alpha, roomId).result.winner, 'B');
  assert.equal(store.list(alpha).length, 1);

  const secondRoom = { id: 'room_2', result: { status: 'CONFIRMED', winner: 'A' } };
  receive(resultEvent('evt_a_2', start + 6000, 'CONFIRMED', secondRoom));
  receive(resultEvent('evt_z_2', start + 6000, 'CONFIRMED', { ...secondRoom, result: { status: 'CONFIRMED', winner: 'B' } }));
  assert.equal(store.getRoom(alpha, secondRoom.id).result.winner, 'B');
});

test('preserva placar, saúde e identificação de duplicatas após reabrir SQLite em disco', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lobbito-portal-webhook-'));
  const databasePath = join(directory, 'results', 'webhooks.sqlite');
  t.after(async () => {
    await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(databasePath + suffix, { force: true })));
    await rmdir(dirname(databasePath));
    await rmdir(directory);
  });

  let time = start;
  const config = { secrets: keys, databasePath, now: () => time };
  const result = resultEvent('evt_persistido', time);
  const health = { id: 'evt_saude', type: 'webhook.test', createdAt: result.createdAt, data: {} };
  const original = await openWebhooks(config);
  try {
    for (const event of [result, health]) {
      const body = Buffer.from(JSON.stringify(event));
      original.receive(alpha, sign(body, alphaSecret, time), body);
    }
  } finally {
    original.close();
  }
  time += 30_000;
  const reopened = await openWebhooks(config);
  try {
    const duplicate = Buffer.from(JSON.stringify({ ...result, data: { ...result.data, result: { status: 'CONFIRMED', winner: 'B' } } }));
    reopened.receive(alpha, sign(duplicate, alphaSecret, time), duplicate);
    assert.equal(reopened.getRoom(alpha, roomId).result.winner, 'A');
    assert.deepEqual(reopened.getStatus(alpha), {
      lastResultAt: new Date(start).toISOString(), lastTestAt: new Date(start).toISOString(),
    });
  } finally {
    reopened.close();
  }
});

test('recusa configuração que permitiria reaproveitar uma assinatura entre contas', async () => {
  await assert.rejects(openWebhooks({
    secrets: new Map([[alpha, alphaSecret], [beta, alphaSecret]]), databasePath: ':memory:',
  }), /segredo de webhook diferente/);
});

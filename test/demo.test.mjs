import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi, presets } from '../public/demo.js';

test('a demonstração simula a partida sem gerar credenciais', async () => {
  const demo = createDemoApi([{ id: '2x2' }]);
  assert.equal((await demo('/session')).account.plan.name, 'Simulado');
  assert.equal(presets['br-squad'].capacity, 48);
  const { room } = await demo('/rooms', { method: 'POST', body: { mode: presets['cs-duplas'].mode } });
  assert.equal(room.status, 'CREATING');
  const path = '/rooms/' + room.id;
  const ready = await demo(path);
  assert.equal(ready.status, 'WAITING_PLAYERS');
  assert.equal(ready.roomId, undefined);
  assert.equal(ready.password, undefined);
  assert.equal((await demo(path + '/start', { method: 'POST' })).room.status, 'IN_PROGRESS');
  assert.equal((await demo(path)).result.status, 'CONFIRMED');
});

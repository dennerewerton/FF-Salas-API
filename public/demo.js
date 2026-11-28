export const presets = Object.freeze({
  'cs-duplas': { family: 'cs', mode: '2x2', minutes: 10, gloo: '', headshots: '' },
  'cs-capa': { family: 'cs', mode: '4x4', minutes: 10, gloo: 'true', headshots: 'true' },
  'br-squad': { family: 'br', mode: 'br-squad', minutes: 15, capacity: 48 },
});

export function createDemoApi(catalog) {
  const account = { name: 'Conta de demonstração', plan: { name: 'Simulado' } };
  let room, sequence = 0;
  const pending = () => room?.status === 'CREATING';
  return async (path, { method = 'GET', body } = {}) => {
    if (path === '/session' && method === 'DELETE') return { connected: false };
    if (path === '/session') return { connected: true, account, attempt: room && { room, pending: pending() } };
    if (path === '/account') return account;
    if (path === '/modes') return { modes: catalog, characters: [], petCatalogs: {} };
    if (path === '/results') return { configured: false, data: [] };
    if (path === '/rooms' && method === 'GET') return { data: room ? [room] : [], nextCursor: null };
    if (path === '/rooms' && method === 'POST') {
      room = { id: `demo_${++sequence}`, name: 'Sala simulada', mode: body.mode, status: 'CREATING',
        createdAt: new Date().toISOString(), autoStart: Boolean(body.autoStart), autoResult: Boolean(body.autoResult) };
      return { room };
    }
    if (room && path === `/rooms/${room.id}` && method === 'GET') {
      if (pending()) room = { ...room, status: 'WAITING_PLAYERS', joinDeadline: new Date(Date.now() + 10 * 60_000).toISOString() };
      else if (room.status === 'IN_PROGRESS') {
        const winner = room.mode.startsWith('br-') ? { winnerTeamId: 1, teams: [{ teamId: 1, placement: 1 }] } : { winner: 'A' };
        room = { ...room, status: 'FINISHED', result: { status: 'CONFIRMED', ...winner } };
      }
      return room;
    }
    if (room?.status === 'WAITING_PLAYERS' && method === 'POST') {
      const status = path === `/rooms/${room.id}/start` ? 'IN_PROGRESS'
        : path === `/rooms/${room.id}/cancel` ? 'CANCELLED' : null;
      if (status) {
        room = { ...room, status };
        return { room };
      }
    }
    throw Object.assign(new Error('A ação está indisponível nesta etapa da demonstração.'), { code: 'demo_state' });
  };
}

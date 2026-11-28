import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openAttempts(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS pending_room_requests (
      account TEXT PRIMARY KEY, request_key TEXT NOT NULL, room_id TEXT
    );
  `);
  const get = db.prepare('SELECT request_key AS key, room_id AS roomId FROM pending_room_requests WHERE account = ?');
  const create = db.prepare('INSERT INTO pending_room_requests (account, request_key) VALUES (?, ?) ON CONFLICT DO NOTHING');
  const update = db.prepare('UPDATE pending_room_requests SET room_id = ? WHERE account = ? AND request_key = ?');
  const finish = db.prepare('DELETE FROM pending_room_requests WHERE account = ? AND request_key = ?');
  return {
    get: account => get.get(account),
    begin: (account, key) => create.run(account, key).changes === 1,
    link: (account, key, roomId) => update.run(roomId, account, key),
    finish: (account, key) => finish.run(account, key),
    close: () => db.close(),
  };
}

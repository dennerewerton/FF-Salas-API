import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpError, isObject, publicRoom } from './contract.mjs';

const resultTypes = new Map([['room.finished', 'CONFIRMED'], ['room.result_pending', 'PENDING']]);
const testType = 'webhook.test';
const eventIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const eventDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const signaturePattern = /^t=(\d+),v1=([a-f0-9]{64})$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function invalidPayload() {
  return new HttpError(400, 'invalid_webhook_payload', 'O corpo do webhook da Lobbito é inválido.');
}

function verifySignature(secret, signature, rawBody, receivedAt) {
  const match = typeof signature === 'string' && signaturePattern.exec(signature);
  const epoch = match && Number(match[1]);
  const badSignature = () => new HttpError(401, 'invalid_webhook_signature', 'A assinatura do webhook da Lobbito não pôde ser validada.');
  if (!Buffer.isBuffer(rawBody) || !match || match[0] !== signature || !Number.isSafeInteger(epoch)
    || Math.abs(receivedAt / 1000 - epoch) > 300) {
    throw badSignature();
  }
  const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) throw badSignature();
}

function parseEvent(rawBody, eventHeader, deliveryHeader) {
  let event;
  try {
    event = JSON.parse(utf8.decode(rawBody));
  } catch {
    throw invalidPayload();
  }
  if (!isObject(event) || typeof event.type !== 'string'
    || (eventHeader !== undefined && eventHeader !== event.type)
    || (deliveryHeader !== undefined && deliveryHeader !== event.id)) {
    throw invalidPayload();
  }
  if (event.type !== testType && !resultTypes.has(event.type)) return null;

  const createdAt = typeof event.createdAt === 'string' && eventDatePattern.test(event.createdAt)
    ? Date.parse(event.createdAt) : NaN;
  if (typeof event.id !== 'string' || !eventIdPattern.test(event.id) || !Number.isSafeInteger(createdAt) || !isObject(event.data)) {
    throw invalidPayload();
  }
  if (event.type === testType) return { id: event.id, type: event.type };

  const room = publicRoom(event.data, { includePassword: false });
  const status = resultTypes.get(event.type);
  if (room?.result?.status !== status || (status === 'CONFIRMED' && !room.result.winner && !room.result.winnerTeamId)) {
    throw invalidPayload();
  }
  return { id: event.id, type: event.type, createdAt, room };
}

function isoDate(value) {
  return value === null ? null : new Date(value).toISOString();
}

export async function openWebhooks({ secrets, databasePath, now = Date.now }) {
  const accountSecrets = new Map(secrets);
  if (new Set(accountSecrets.values()).size !== accountSecrets.size) {
    throw new Error('Cada conta Lobbito precisa de um segredo de webhook diferente.');
  }

  const { DatabaseSync } = await import('node:sqlite');
  if (databasePath !== ':memory:') await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);

  try {
    database.exec(`
      PRAGMA busy_timeout = 2500;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS lobbito_webhook_events (
        account_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, event_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS lobbito_webhook_rooms (
        account_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        confirmed INTEGER NOT NULL,
        room_json TEXT NOT NULL,
        PRIMARY KEY (account_id, room_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS lobbito_webhook_room_receipts
        ON lobbito_webhook_rooms (account_id, received_at DESC, event_created_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS lobbito_webhook_event_receipts
        ON lobbito_webhook_events (account_id, event_type, received_at DESC);
    `);
    const rememberEvent = database.prepare(`
      INSERT INTO lobbito_webhook_events (account_id, event_id, event_type, received_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (account_id, event_id) DO NOTHING
    `);
    const rememberRoom = database.prepare(`
      INSERT INTO lobbito_webhook_rooms
        (account_id, room_id, event_id, event_type, event_created_at, received_at, confirmed, room_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, room_id) DO UPDATE SET
        event_id = excluded.event_id,
        event_type = excluded.event_type,
        event_created_at = excluded.event_created_at,
        received_at = excluded.received_at,
        confirmed = excluded.confirmed,
        room_json = excluded.room_json
      WHERE excluded.confirmed > lobbito_webhook_rooms.confirmed
        OR (excluded.confirmed = lobbito_webhook_rooms.confirmed AND
          (excluded.event_created_at > lobbito_webhook_rooms.event_created_at
            OR (excluded.event_created_at = lobbito_webhook_rooms.event_created_at
              AND excluded.event_id > lobbito_webhook_rooms.event_id)))
    `);
    const roomList = database.prepare(`
      SELECT room_json, received_at, event_type FROM lobbito_webhook_rooms
      WHERE account_id = ? ORDER BY received_at DESC, event_created_at DESC, event_id DESC LIMIT 50
    `);
    const findRoom = database.prepare('SELECT room_json FROM lobbito_webhook_rooms WHERE account_id = ? AND room_id = ?');
    const newestOccurrence = database.prepare(`
      SELECT received_at FROM lobbito_webhook_events WHERE account_id = ? AND event_type = ?
      ORDER BY received_at DESC LIMIT 1
    `);

    return {
      hasAccount(accountId) {
        return accountSecrets.has(accountId);
      },

      receive(accountId, signature, rawBody, { event, delivery } = {}) {
        const secret = accountSecrets.get(accountId);
        if (!secret) throw new HttpError(404, 'webhook_not_found', 'Endereço de webhook não encontrado.');
        const receivedAt = now();
        verifySignature(secret, signature, rawBody, receivedAt);
        const incoming = parseEvent(rawBody, event, delivery);
        if (!incoming) return;

        database.exec('BEGIN IMMEDIATE');
        try {
          const insert = rememberEvent.run(accountId, incoming.id, incoming.type, receivedAt);
          if (insert.changes && incoming.room) {
            rememberRoom.run(accountId, incoming.room.id, incoming.id, incoming.type, incoming.createdAt,
              receivedAt, incoming.room.result.status === 'CONFIRMED' ? 1 : 0, JSON.stringify(incoming.room));
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },

      list(accountId) {
        if (!accountSecrets.has(accountId)) return [];
        return roomList.all(accountId).map(({ room_json, received_at, event_type }) => ({
          room: JSON.parse(room_json), receivedAt: isoDate(received_at), type: event_type,
        }));
      },

      getRoom(accountId, roomId) {
        if (!accountSecrets.has(accountId)) return null;
        const row = findRoom.get(accountId, roomId);
        return row ? JSON.parse(row.room_json) : null;
      },

      getStatus(accountId) {
        if (!accountSecrets.has(accountId)) return { lastTestAt: null, lastResultAt: null };
        const latest = (type) => newestOccurrence.get(accountId, type)?.received_at ?? null;
        const finished = latest('room.finished');
        const pending = latest('room.result_pending');
        const lastResultAt = finished === null ? pending : pending === null ? finished : Math.max(finished, pending);
        return { lastTestAt: isoDate(latest(testType)), lastResultAt: isoDate(lastResultAt) };
      },

      close() {
        database.close();
        accountSecrets.clear();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

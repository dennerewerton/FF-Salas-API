import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HttpError, ROOM_ID, pendingRoom, publicAccount, publicCharacterValidation, publicModes, publicRoom, roomRequest } from './lib/contract.mjs';
import { openWebhooks } from './lib/webhooks.mjs';
import { openAttempts } from './lib/attempts.mjs';
import { releaseInfo } from './lib/release_info.mjs';

const API_ORIGIN = 'https://api.lobbito.com.br';
const COOKIE = 'lobbito_portal_session';
const SESSION_TTL = 2 * 60 * 60;
const JSON_LIMIT = 16 * 1024;
const SESSION_LIMIT = 1000;
const WEBHOOK_JSON_LIMIT = 128 * 1024;
const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{1,120}$/;
const WEBHOOK_ROUTE = '/webhooks/lobbito/';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
  ['/favicon.ico', ['favicon.ico', 'image/vnd.microsoft.icon']],
  ['/arena.jpg', ['arena.jpg', 'image/jpeg']],
]);

const errorMessages = {
  unauthorized: 'A chave da API está inválida, revogada ou sem acesso. Confira a chave da sua conta Lobbito.',
  invalid_request: 'A Lobbito recusou a configuração. Confira os campos da sala e tente novamente.',
  invalid_json: 'A Lobbito recusou a configuração da sala.',
  plan_required: 'Este recurso exige um plano ativo na Lobbito.',
  plan_feature: 'Seu plano da Lobbito não inclui este recurso.',
  not_found: 'A sala não foi encontrada na sua conta.',
  invalid_state: 'A operação está indisponível para o estado atual da sala.',
  rate_limited: 'A Lobbito limitou a frequência de solicitações. Aguarde um pouco e tente novamente.',
  quota_exceeded: 'Sua cota de salas da Lobbito foi atingida.',
  concurrency_limit: 'Sua conta já atingiu o limite de salas simultâneas.',
  capacity_unavailable: 'A Lobbito está temporariamente sem capacidade para criar salas. Tente novamente em instantes.',
  creation_failed: 'A Lobbito confirmou que a sala não pôde ser criada. Você pode enviar um novo pedido.',
  request_received: 'A Arena encontrou uma sala para o protocolo. Clique em Verificar pedido para acompanhar.',
  request_abandoned: 'A Arena confirmou que o pedido anterior foi encerrado sem criar sala.',
  idempotency_conflict: 'A Lobbito detectou um conflito neste pedido de criação.',
};

const restrictionStartErrors = {
  characters_not_allowed: 'Há habilidades incompatíveis com as regras da sala. Peça aos jogadores indicados para ajustar a seleção antes de iniciar.',
  pets_not_allowed: 'Há pets ou habilidades de pet incompatíveis com as regras da sala. Peça aos jogadores indicados para ajustar a seleção antes de iniciar.',
  character_validation_unavailable: 'A Lobbito ainda não conseguiu conferir as regras de personagens e pets. Verifique a sala e tente iniciar novamente quando a conferência estiver disponível.',
};

function actionUnconfirmed() {
  return new HttpError(502, 'action_unconfirmed', 'A Lobbito ainda não confirmou a ação. Consulte o status da sala antes de tentar novamente.');
}

function upstreamError(response, data, creating, action) {
  const code = data?.error?.code;
  const retryAfter = response.headers.get('Retry-After');
  const options = {
    retryAfter: retryAfter && /^\d{1,5}$/.test(retryAfter) ? retryAfter : undefined,
    room: creating && code === 'creation_failed' ? publicRoom(data.room, { includePassword: false }) : undefined,
    uncertain: creating && ((response.status >= 500 && !['creation_failed', 'capacity_unavailable'].includes(code)) || response.status === 408),
  };

  if (action && (response.status >= 500 || response.status === 408)) return actionUnconfirmed();
  if (action === 'start' && response.status === 409 && typeof code === 'string' && Object.hasOwn(restrictionStartErrors, code)) {
    const characterValidation = publicCharacterValidation(data.error.details?.characterValidation);
    return new HttpError(409, code, restrictionStartErrors[code], {
      ...options, details: characterValidation ? { characterValidation } : undefined,
    });
  }
  if (typeof code === 'string' && Object.hasOwn(errorMessages, code)) {
    return new HttpError(response.status, code, errorMessages[code], options);
  }
  if (response.status === 401) return new HttpError(401, 'unauthorized', errorMessages.unauthorized, options);
  if (action && response.status === 404) return new HttpError(404, 'not_found', errorMessages.not_found, options);
  if (action && response.status === 409) return new HttpError(409, 'invalid_state', errorMessages.invalid_state, options);
  if (response.status === 429) return new HttpError(429, 'rate_limited', errorMessages.rate_limited, options);
  const message = options.uncertain
    ? 'A Lobbito ainda não confirmou o pedido. Retome a mesma tentativa para evitar criar outra sala.'
    : 'A Lobbito não conseguiu atender à solicitação. Tente novamente em instantes.';
  return new HttpError(response.status >= 500 ? 502 : response.status, 'upstream_error', message, options);
}

function invalidResponse(creating = false) {
  return new HttpError(502, 'invalid_upstream_response', creating
    ? 'A resposta da Lobbito não confirmou o pedido. Retome a mesma tentativa para evitar criar outra sala.'
    : 'A Lobbito devolveu uma resposta inesperada. Tente novamente em instantes.', { uncertain: creating });
}

async function lobbito(fetchApi, key, path, { attempt, action = false, method = attempt || action ? 'POST' : 'GET' } = {}) {
  const creating = Boolean(attempt);
  const headers = { Accept: 'application/json', Authorization: `Bearer ${key}` };
  if (attempt) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = attempt.key;
  }

  let response;
  let data;
  try {
    response = await fetchApi(`${API_ORIGIN}${path}`, {
      headers,
      method,
      body: attempt ? JSON.stringify(attempt.payload) : undefined,
      signal: AbortSignal.timeout(creating ? 50_000 : action ? 35_000 : 12_000),
      redirect: 'error',
      cache: 'no-store',
    });
    const body = await response.text();
    if (!action || body.trim()) data = JSON.parse(body);
  } catch (cause) {
    if (cause instanceof SyntaxError && response) {
      if (!response.ok) throw upstreamError(response, undefined, creating, action);
      if (action) throw actionUnconfirmed();
      throw invalidResponse(creating);
    }
    if (action) throw actionUnconfirmed();
    throw new HttpError(502, 'connection_error', creating
      ? 'A conexão caiu antes da confirmação. Retome a mesma tentativa para evitar criar outra sala.'
      : 'Não foi possível conectar à Lobbito. Tente novamente em instantes.', { uncertain: creating });
  }
  if (!response.ok) throw upstreamError(response, data, creating, action);
  return { status: response.status, data };
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request, limit = JSON_LIMIT) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'invalid_content_type', 'Envie os dados como JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, 'payload_too_large', 'O pedido excede o tamanho permitido.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  const body = await readJsonBody(request);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'O pedido não contém JSON válido.');
  }
}

function sessionToken(request) {
  return request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})(?:;|$)`))?.[1];
}

function setSessionCookie(response, token, secure) {
  response.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_TTL : 0}${secure ? '; Secure' : ''}`);
}

function sameOrigin(request, allowedOrigin) {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (allowedOrigin) return origin === allowedOrigin;
  try {
    const { protocol, host } = new URL(origin);
    return ['http:', 'https:'].includes(protocol) && host === request.headers.host;
  } catch {
    return false;
  }
}

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
}

function attemptView(attempt) {
  if (!attempt) return undefined;
  return { pending: attempt.pending, inFlight: attempt.inFlight, room: attempt.room, error: attempt.error,
    protocol: attempt.pending ? attempt.key : undefined, canClose: attempt.canClose || undefined };
}

function sessionView(session) {
  return session ? { connected: true, account: session.account, attempt: attemptView(session.attempt) } : { connected: false };
}

function assignRoom(attempt, room) {
  attempt.room = room;
  attempt.pending = pendingRoom(room);
  attempt.error = undefined;
  attempt.canClose = false;
  if (!attempt.pending) attempt.payload = undefined;
}

function rememberRoom(session, room) {
  const attempt = session.attempt;
  if ((attempt?.room?.id ?? attempt?.roomId) === room.id && (attempt.pending || !pendingRoom(room))) assignRoom(attempt, room);
}

function mergeReceivedResult(room, webhookRoom) {
  if (!webhookRoom || room.result?.status === 'CONFIRMED') return room;
  if (room.result?.status === 'PENDING' && webhookRoom.result.status === 'PENDING') return room;
  return { ...room, status: webhookRoom.status, password: null, result: webhookRoom.result };
}

function webhookPath(accountId) {
  return accountId ? `${WEBHOOK_ROUTE}${accountId}` : null;
}

function resultView(webhooks, accountId, allowedOrigin) {
  const path = webhookPath(accountId);
  const configured = Boolean(accountId && webhooks?.hasAccount(accountId));
  const status = configured ? webhooks.getStatus(accountId) : { lastTestAt: null, lastResultAt: null };
  return {
    configured,
    accountId: accountId ?? null,
    url: path && allowedOrigin?.startsWith('https://') ? `${allowedOrigin}${path}` : null,
    ...status,
    data: configured ? webhooks.list(accountId) : [],
  };
}

async function lookupAccount(fetchApi, key) {
  const { data } = await lobbito(fetchApi, key, '/v1/me');
  const account = publicAccount(data);
  if (!account) throw invalidResponse();
  const accountId = typeof data.id === 'string' && ACCOUNT_ID.test(data.id) ? data.id : null;
  return { account, accountId };
}

async function lookupRoom(fetchApi, session, id) {
  const { data } = await lobbito(fetchApi, session.key, `/v1/rooms/${id}`);
  const room = publicRoom(data?.room ?? data, { includeCharacterValidation: true });
  if (room?.id !== id) throw invalidResponse();
  return room;
}

async function roomAction(fetchApi, session, id, action) {
  const { data, status } = await lobbito(fetchApi, session.key, `/v1/rooms/${id}/${action}`, { action });
  let room = publicRoom(data?.room ?? data, { includeCharacterValidation: true });
  if (room?.id !== id) {
    try {
      room = await lookupRoom(fetchApi, session, id);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      room = null;
    }
  }
  if (room) rememberRoom(session, room);
  return { room, status: status === 202 ? 202 : 200 };
}

async function sendAttempt(fetchApi, session, attempt, response, syncAttempt) {
  const wasUncertain = attempt.pending && !attempt.room && Boolean(attempt.error);
  attempt.inFlight = true;
  try {
    const { data, status } = await lobbito(fetchApi, session.key, '/v1/rooms', { attempt });
    const room = publicRoom(data?.room ?? data, { includeCharacterValidation: true });
    if (!room) throw invalidResponse(true);
    assignRoom(attempt, room);
    syncAttempt(session, attempt);
    json(response, status, { room });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.room) assignRoom(attempt, error.room);
    attempt.pending = !error.room && (Boolean(error.uncertain) || (wasUncertain && !['creation_failed', 'request_abandoned'].includes(error.code)));
    attempt.error = error.toJSON();
    if (!attempt.pending) attempt.payload = undefined;
    syncAttempt(session, attempt);
    throw error;
  } finally {
    attempt.inFlight = false;
  }
}

export function createServer({ fetchApi = globalThis.fetch, secureCookies = false, allowedOrigin, webhooks,
  attempts = openAttempts() } = {}) {
  const sessions = new Map();
  function restoreAttempt(session) {
    if (!session?.accountId) return;
    const saved = attempts.get(session.accountId);
    if (saved && saved.key !== session.attempt?.key) session.attempt = { ...saved, pending: true };
    if (saved?.roomId && !session.attempt.room) session.attempt.roomId = saved.roomId;
    if (!saved && session.attempt?.pending && !session.attempt.inFlight) session.attempt = undefined;
  }
  function syncAttempt(session, attempt) {
    if (!attempt.pending) attempts.finish(session.accountId, attempt.key);
    else if (attempt.room?.id) attempts.link(session.accountId, attempt.key, attempt.room.id);
  }
  function withReceivedResult(session, room) {
    return mergeReceivedResult(room, webhooks?.getRoom(session.accountId, room.id));
  }
  function pruneExpired() {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (entry.expires <= now) sessions.delete(id);
    }
  }
  const expirySweep = setInterval(pruneExpired, 60_000).unref();
  const server = createHttpServer(async (request, response) => {
    securityHeaders(response);
    const secure = secureCookies || Boolean(request.socket.encrypted);
    const token = sessionToken(request);
    try {
      const url = new URL(request.url, 'http://portal.local');
      const { pathname } = url;
      const { method } = request;

      if (method === 'GET' && pathname === '/health') return json(response, 200, { status: 'ok', ...releaseInfo });

      if (pathname.startsWith(WEBHOOK_ROUTE)) {
        const accountId = pathname.slice(WEBHOOK_ROUTE.length);
        if (method !== 'POST' || !ACCOUNT_ID.test(accountId) || !webhooks?.hasAccount(accountId)) {
          throw new HttpError(404, 'not_found', 'Webhook indisponível.');
        }
        const body = await readJsonBody(request, WEBHOOK_JSON_LIMIT);
        webhooks.receive(accountId, request.headers['x-lobbito-signature'], body, {
          event: request.headers['x-lobbito-event'], delivery: request.headers['x-lobbito-delivery'],
        });
        response.writeHead(204).end();
        return;
      }

      if (!pathname.startsWith('/api/')) {
        const asset = assets.get(pathname);
        if (!asset || !['GET', 'HEAD'].includes(method)) throw new HttpError(404, 'not_found', 'Página não encontrada.');
        const [filename, contentType] = asset;
        const body = await readFile(new URL(`./public/${filename}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
        response.end(method === 'HEAD' ? undefined : body);
        return;
      }

      if (!sameOrigin(request, allowedOrigin)) {
        throw new HttpError(403, 'origin_forbidden', 'Abra o portal para fazer esta solicitação.');
      }
      let current = sessions.get(token);
      if (current?.expires <= Date.now()) {
        sessions.delete(token);
        current = undefined;
      }
      restoreAttempt(current);

      if (pathname === '/api/session') {
        if (method === 'GET') return json(response, 200, sessionView(current));
        if (method === 'DELETE') {
          sessions.delete(token);
          setSessionCookie(response, '', secure);
          return json(response, 200, { connected: false });
        }
        if (method === 'POST') {
          const data = await readJson(request);
          const key = typeof data?.key === 'string' ? data.key.trim() : '';
          if (!/^lbt_live_[A-Za-z0-9_-]{1,240}$/.test(key)) {
            throw new HttpError(400, 'invalid_key', 'Informe uma chave válida da Lobbito que comece com lbt_live_.');
          }
          const { account, accountId } = await lookupAccount(fetchApi, key);
          pruneExpired();
          if (!current && sessions.size >= SESSION_LIMIT) {
            throw new HttpError(503, 'session_capacity', 'O portal está temporariamente ocupado. Tente novamente em instantes.');
          }
          const id = randomBytes(32).toString('hex');
          const newSession = { key, account, accountId, expires: Date.now() + SESSION_TTL * 1000 };
          if (current?.accountId === accountId) newSession.attempt = current?.attempt;
          restoreAttempt(newSession);
          sessions.delete(token);
          sessions.set(id, newSession);
          setSessionCookie(response, id, secure);
          return json(response, 200, sessionView(newSession));
        }
      }

      if (!current) throw new HttpError(401, 'session_required', 'Conecte sua chave da Lobbito para continuar.');

      if (method === 'GET' && pathname === '/api/results') {
        if (webhooks?.hasAccount(current.accountId)) {
          const { accountId } = await lookupAccount(fetchApi, current.key);
          if (accountId !== current.accountId || sessions.get(token) !== current || current.expires <= Date.now()) {
            throw new HttpError(401, 'unauthorized', errorMessages.unauthorized);
          }
        }
        return json(response, 200, resultView(webhooks, current.accountId, allowedOrigin));
      }
      if (method === 'GET' && pathname === '/api/account') {
        const { account } = await lookupAccount(fetchApi, current.key);
        current.account = account;
        return json(response, 200, account);
      }
      if (method === 'GET' && pathname === '/api/modes') {
        const { data } = await lobbito(fetchApi, current.key, '/v1/modes');
        return json(response, 200, publicModes(data));
      }
      if (method === 'GET' && pathname === '/api/rooms') {
        const cursor = url.searchParams.get('cursor');
        if (cursor && cursor.length > 1024) throw new HttpError(400, 'invalid_cursor', 'A página solicitada é inválida.');
        const query = new URLSearchParams({ limit: '20' });
        if (cursor) query.set('cursor', cursor);
        const { data } = await lobbito(fetchApi, current.key, `/v1/rooms?${query}`);
        if (!Array.isArray(data?.data)) throw invalidResponse();
        const next = data.hasMore !== false && typeof data.nextCursor === 'string' && data.nextCursor.length <= 1024;
        const rooms = data.data.map((entry) => publicRoom(entry, { includePassword: false }))
          .filter(Boolean).map((room) => withReceivedResult(current, room));
        return json(response, 200, { data: rooms, nextCursor: next ? data.nextCursor : null });
      }
      if (method === 'POST' && pathname === '/api/rooms') {
        const payload = roomRequest(await readJson(request));
        if (sessions.get(token) !== current || current.expires <= Date.now()) {
          throw new HttpError(401, 'session_required', 'Conecte sua chave da Lobbito para continuar.');
        }
        if (!current.accountId) throw invalidResponse();
        const attempt = { key: randomUUID(), payload, pending: true };
        if (current.attempt?.pending || !attempts.begin(current.accountId, attempt.key)) {
          throw new HttpError(409, 'attempt_pending', 'Acompanhe ou retome o pedido atual antes de criar outra sala.');
        }
        current.attempt = attempt;
        await sendAttempt(fetchApi, current, attempt, response, syncAttempt);
        return;
      }
      if (method === 'POST' && pathname === '/api/retry') {
        const attempt = current.attempt;
        if (!attempt?.pending) throw new HttpError(409, 'no_pending_attempt', 'Não há pedido pendente para retomar.');
        if (attempt.inFlight) throw new HttpError(409, 'attempt_pending', 'O pedido atual ainda está sendo enviado.');
        const knownId = attempt.room?.id ?? attempt.roomId;
        if (knownId || !attempt.payload) {
          attempt.inFlight = true;
          try {
            const room = knownId ? await lookupRoom(fetchApi, current, knownId)
              : publicRoom((await lobbito(fetchApi, current.key, `/v1/room-requests/${attempt.key}`)).data,
                  { includeCharacterValidation: true });
            if (!room) throw invalidResponse();
            assignRoom(attempt, room);
            syncAttempt(current, attempt);
            return json(response, attempt.pending ? 202 : 200, { room });
          } catch (error) {
            if (!knownId && error instanceof HttpError && error.code === 'not_found') {
              attempt.canClose = true;
              throw new HttpError(409, 'request_unconfirmed',
                'A Arena ainda não encontrou uma sala para este protocolo. Você pode verificar de novo ou encerrar o pedido.');
            }
            throw error;
          } finally {
            attempt.inFlight = false;
          }
        }
        await sendAttempt(fetchApi, current, attempt, response, syncAttempt);
        return;
      }
      if (method === 'DELETE' && pathname === '/api/retry') {
        const attempt = current.attempt;
        if (!attempt?.pending || !attempt.canClose || attempt.inFlight) {
          throw new HttpError(409, 'attempt_pending', 'Verifique o protocolo do pedido antes de tentar encerrá-lo.');
        }
        attempt.inFlight = true;
        try {
          const { data } = await lobbito(fetchApi, current.key, `/v1/room-requests/${attempt.key}`, { method: 'DELETE' });
          if (data?.ok !== true) throw invalidResponse();
          attempts.finish(current.accountId, attempt.key);
          current.attempt = undefined;
          return json(response, 200, { closed: true });
        } catch (error) {
          if (error instanceof HttpError && error.code === 'request_received') attempt.canClose = false;
          throw error;
        } finally {
          attempt.inFlight = false;
        }
      }
      if (pathname.startsWith('/api/rooms/')) {
        const [id, action, ...extra] = pathname.slice('/api/rooms/'.length).split('/');
        if (ROOM_ID.test(id) && extra.length === 0) {
          if (method === 'GET' && action === undefined) {
            const room = withReceivedResult(current, await lookupRoom(fetchApi, current, id));
            rememberRoom(current, room);
            if (current.attempt?.room?.id === room.id) syncAttempt(current, current.attempt);
            return json(response, 200, room);
          }
          if (method === 'POST' && ['start', 'cancel'].includes(action)) {
            const { room, status } = await roomAction(fetchApi, current, id, action);
            if (room && current.attempt?.room?.id === room.id) syncAttempt(current, current.attempt);
            return json(response, status, { room: room && withReceivedResult(current, room) });
          }
        }
      }
      throw new HttpError(404, 'not_found', 'Página não encontrada.');
    } catch (error) {
      const safeError = error instanceof HttpError ? error
        : error.code === 'ENOENT' ? new HttpError(404, 'not_found', 'Página não encontrada.')
          : new HttpError(500, 'internal', 'O portal encontrou um erro inesperado. Tente novamente em instantes.');
      if (safeError.code === 'unauthorized' && request.url.split('?')[0] !== '/api/session') {
        sessions.delete(token);
      }
      if (safeError.retryAfter) response.setHeader('Retry-After', safeError.retryAfter);
      if (!response.headersSent) json(response, safeError.status, { error: safeError.toJSON(), room: safeError.room });
      else response.end();
    }
  });
  server.once('close', () => {
    clearInterval(expirySweep);
    sessions.clear();
    webhooks?.close();
    attempts.close();
  });
  return server;
}

async function configuredWebhooks() {
  const config = process.env.LOBBITO_WEBHOOK_SECRETS;
  if (!config) return undefined;
  let entries;
  try {
    const parsed = JSON.parse(config);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    entries = Object.entries(parsed);
    const distinctSecrets = new Set(entries.map(([, secret]) => secret));
    if (distinctSecrets.size !== entries.length || entries.some(([id, secret]) =>
      !ACCOUNT_ID.test(id) || typeof secret !== 'string' || !/^whsec_[!-~]{8,249}$/.test(secret))) throw new Error();
  } catch {
    throw new Error('Configure LOBBITO_WEBHOOK_SECRETS como um objeto JSON com um segredo whsec_ distinto para cada conta acct_.');
  }
  if (!entries.length) return undefined;
  const databasePath = process.env.LOBBITO_WEBHOOK_DB
    ? resolve(process.env.LOBBITO_WEBHOOK_DB)
    : fileURLToPath(new URL('./data/lobbito-results.sqlite', import.meta.url));
  return openWebhooks({ secrets: new Map(entries), databasePath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3080);
  const host = process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const allowedOrigin = process.env.PORTAL_ORIGIN ? new URL(process.env.PORTAL_ORIGIN).origin : undefined;
  const secureCookies = process.env.SECURE_COOKIES === 'true' || (allowedOrigin?.startsWith('https://') ?? false);
  const webhooks = await configuredWebhooks();
  const attempts = openAttempts(resolve(process.env.LOBBITO_ATTEMPTS_DB || 'data/lobbito-attempts.sqlite'));
  createServer({ allowedOrigin, secureCookies, webhooks, attempts }).listen(port, host, () => {
    console.log(`Portal de Salas disponível em http://${host}:${port}`);
  });
}

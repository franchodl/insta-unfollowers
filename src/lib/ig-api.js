/**
 * Instagram private web API client.
 *
 * This module runs inside the instagram.com origin (imported by the content
 * script), so every request automatically carries the user's own session
 * cookies — no credentials are ever read, stored, or sent anywhere else.
 *
 * fetch/delay/random are injectable so the pagination and retry logic can be
 * unit-tested in Node (see tests/ig-api.test.mjs).
 */

import { toUserRecord } from './compare.js';

// App id Instagram's own web client sends; required by the api/v1 endpoints.
export const IG_APP_ID = '936619743392459';
export const PAGE_SIZE = 100;
const API_BASE = 'https://www.instagram.com/api/v1';

export class IgApiError extends Error {
  constructor(message, { status = null, code = 'ig_api', retriable = false } = {}) {
    super(message);
    this.name = 'IgApiError';
    this.status = status;
    this.code = code;
    this.retriable = retriable;
  }
}

/** Read a cookie by name. cookieString is injectable for tests. */
export function getCookie(name, cookieString) {
  const source = cookieString ?? (typeof document === 'undefined' ? '' : document.cookie);
  for (const part of source.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      const value = trimmed.slice(eq + 1);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(csrfToken) {
  const headers = { 'x-ig-app-id': IG_APP_ID, accept: 'application/json' };
  if (csrfToken) headers['x-csrftoken'] = csrfToken;
  return headers;
}

function throwForStatus(res) {
  if (res.status === 401 || res.status === 403) {
    throw new IgApiError('Instagram rejected the request — make sure you are logged in.', {
      status: res.status,
      code: 'auth',
    });
  }
  if (res.status === 429) {
    throw new IgApiError('Instagram is rate-limiting requests.', {
      status: 429,
      code: 'rate_limit',
      retriable: true,
    });
  }
  if (!res.ok) {
    throw new IgApiError(`Instagram returned HTTP ${res.status}.`, {
      status: res.status,
      code: 'http',
      retriable: res.status >= 500,
    });
  }
}

async function parseJson(res) {
  try {
    return await res.json();
  } catch {
    throw new IgApiError('Instagram returned a non-JSON response.', { code: 'bad_body' });
  }
}

/** Fetch one page of a follow list ('followers' or 'following'). */
export async function fetchFollowListPage({
  userId,
  kind,
  maxId = null,
  pageSize = PAGE_SIZE,
  csrfToken = null,
  fetchFn = globalThis.fetch,
}) {
  if (kind !== 'followers' && kind !== 'following') {
    throw new IgApiError(`Unknown follow list kind: ${kind}`, { code: 'bad_kind' });
  }
  const params = new URLSearchParams({ count: String(pageSize) });
  if (maxId) params.set('max_id', maxId);
  if (kind === 'followers') params.set('search_surface', 'follow_list_page');
  const res = await fetchFn(`${API_BASE}/friendships/${userId}/${kind}/?${params}`, {
    headers: buildHeaders(csrfToken),
    credentials: 'include',
  });
  throwForStatus(res);
  const body = await parseJson(res);
  if (body?.status !== 'ok' || !Array.isArray(body.users)) {
    throw new IgApiError('Unexpected response shape from Instagram.', { code: 'bad_body' });
  }
  return { users: body.users, nextMaxId: body.next_max_id ?? null };
}

/** Fetch the logged-in user's profile counts (for progress bars) and username. */
export async function fetchUserInfo({ userId, csrfToken = null, fetchFn = globalThis.fetch }) {
  const res = await fetchFn(`${API_BASE}/users/${userId}/info/`, {
    headers: buildHeaders(csrfToken),
    credentials: 'include',
  });
  throwForStatus(res);
  const body = await parseJson(res);
  const u = body?.user ?? {};
  return {
    username: u.username ?? null,
    followerCount: u.follower_count ?? null,
    followingCount: u.following_count ?? null,
  };
}

/**
 * Follow or unfollow a single account (user-initiated, one at a time — this
 * client deliberately has no bulk mode). Returns { following: boolean }.
 */
export async function setFollowState({
  targetId,
  follow,
  csrfToken = null,
  fetchFn = globalThis.fetch,
}) {
  const action = follow ? 'create' : 'destroy';
  const res = await fetchFn(`${API_BASE}/friendships/${action}/${targetId}/`, {
    method: 'POST',
    headers: {
      ...buildHeaders(csrfToken),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'container_module=self_unified_follow_lists',
    credentials: 'include',
  });
  throwForStatus(res);
  const body = await parseJson(res);
  if (body?.status !== 'ok') {
    throw new IgApiError('Instagram rejected the follow change.', { code: 'bad_body' });
  }
  return { following: Boolean(body.friendship_status?.following ?? follow) };
}

/**
 * Fetch an entire follow list, paging through max_id cursors with a random
 * human-ish delay between pages and exponential backoff on rate limits.
 * Returns deduplicated, normalized user records.
 */
export async function fetchAllFollows({
  userId,
  kind,
  csrfToken = null,
  fetchFn = globalThis.fetch,
  delayFn = sleep,
  randomFn = Math.random,
  onProgress = () => {},
  isCancelled = () => false,
  pageSize = PAGE_SIZE,
  minDelayMs = 900,
  maxDelayMs = 2200,
  maxRetries = 4,
  retryBaseMs = 5000,
  maxPages = 800,
}) {
  const users = new Map();
  const seenCursors = new Set();
  let maxId = null;
  let page = 0;

  for (;;) {
    if (isCancelled()) throw new IgApiError('Scan cancelled.', { code: 'cancelled' });

    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await fetchFollowListPage({ userId, kind, maxId, pageSize, csrfToken, fetchFn });
        break;
      } catch (err) {
        const retriable = err instanceof IgApiError && err.retriable;
        if (!retriable || attempt >= maxRetries) throw err;
        const backoffMs = retryBaseMs * 2 ** attempt;
        onProgress({ kind, fetched: users.size, page, retryingInMs: backoffMs });
        await delayFn(backoffMs);
        if (isCancelled()) throw new IgApiError('Scan cancelled.', { code: 'cancelled' });
      }
    }

    for (const raw of result.users) {
      const record = toUserRecord(raw);
      if (record.pk) users.set(record.pk, record);
    }
    page += 1;
    onProgress({ kind, fetched: users.size, page });

    if (!result.nextMaxId || page >= maxPages) break;
    // Defensive: never loop forever if Instagram repeats a cursor.
    if (seenCursors.has(result.nextMaxId)) break;
    seenCursors.add(result.nextMaxId);
    maxId = result.nextMaxId;

    await delayFn(minDelayMs + Math.floor(randomFn() * (maxDelayMs - minDelayMs)));
  }

  return [...users.values()];
}

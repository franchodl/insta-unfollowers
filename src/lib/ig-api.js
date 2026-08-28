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
// A near-constant the web client sends on every XHR; harmless if slightly stale.
export const IG_ASBD_ID = '129477';
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

function buildHeaders(csrfToken, { wwwClaim = null, ajaxHash = null } = {}) {
  // Mirror the headers Instagram's own web client sends. In particular
  // x-requested-with: XMLHttpRequest makes Instagram answer POST actions with
  // JSON instead of redirecting to an HTML page.
  const headers = {
    'x-ig-app-id': IG_APP_ID,
    'x-asbd-id': IG_ASBD_ID,
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json',
  };
  if (csrfToken) headers['x-csrftoken'] = csrfToken;
  if (wwwClaim) headers['x-ig-www-claim'] = wwwClaim;
  if (ajaxHash) headers['x-instagram-ajax'] = ajaxHash;
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
  // Clone up front so we can inspect the raw body if json() fails (a response
  // body can only be read once). Only the failure path actually reads it.
  const clone = typeof res.clone === 'function' ? res.clone() : null;
  try {
    return await res.json();
  } catch {
    let raw = null;
    if (clone) {
      try {
        raw = await clone.text();
      } catch {
        raw = null;
      }
    }
    const looksHtml = typeof raw === 'string' && /^\s*<(?:!doctype|html)/i.test(raw.trim());
    const redirectedToLogin =
      Boolean(res.redirected) || (typeof res.url === 'string' && /\/accounts\/login/i.test(res.url));
    if (looksHtml || redirectedToLogin) {
      throw new IgApiError(
        'Instagram redirected to a login or security-check page. Open your instagram.com tab, make sure you are fully logged in (and clear any verification prompt), then try again.',
        { code: 'auth' }
      );
    }
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

function shouldFallbackFollowEndpoint(err) {
  return err instanceof IgApiError && (err.code === 'auth' || err.code === 'bad_body');
}

function requireCsrf(csrfToken) {
  if (!csrfToken) {
    throw new IgApiError(
      'Missing Instagram security token. Reload your instagram.com tab and try again.',
      { code: 'auth' }
    );
  }
}

async function postFriendshipWrite({ url, body, csrfToken, wwwClaim, ajaxHash, fetchFn }) {
  const headers = buildHeaders(csrfToken, { wwwClaim, ajaxHash: ajaxHash ?? '1' });
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: body || undefined,
    credentials: 'include',
  });
  throwForStatus(res);
  const parsed = await parseJson(res);
  if (parsed?.status !== 'ok') {
    throw new IgApiError('Instagram rejected the request.', { code: 'bad_body' });
  }
  return parsed;
}

/**
 * Follow or unfollow a single account (user-initiated, one at a time — this
 * client deliberately has no bulk mode). Returns { following: boolean }.
 *
 * Write requests must run as same-origin fetches inside the instagram.com
 * tab (see page-bridge.js). Isolated-world fetch() sends a chrome-extension
 * Origin, and Instagram answers those POSTs with an HTML login page.
 */
export async function setFollowState({
  targetId,
  follow,
  csrfToken = null,
  wwwClaim = null,
  ajaxHash = null,
  fetchFn = globalThis.fetch,
}) {
  requireCsrf(csrfToken);
  const action = follow ? 'create' : 'destroy';
  const body = new URLSearchParams({
    user_id: String(targetId),
    container_module: follow ? 'profile' : 'profile_unfollow',
    radio_type: 'wifi-none',
  }).toString();
  const args = { body, csrfToken, wwwClaim, ajaxHash, fetchFn };
  let parsed;
  try {
    parsed = await postFriendshipWrite({
      url: `${API_BASE}/friendships/${action}/${targetId}/`,
      ...args,
    });
  } catch (err) {
    if (!shouldFallbackFollowEndpoint(err)) throw err;
    const legacy = follow ? 'follow' : 'unfollow';
    parsed = await postFriendshipWrite({
      url: `https://www.instagram.com/web/friendships/${targetId}/${legacy}/`,
      ...args,
      body: null,
    });
  }
  return { following: Boolean(parsed.friendship_status?.following ?? follow) };
}

/**
 * Remove a follower (they follow you; you are not following them back).
 * One click, one request — no bulk mode. Returns { removed: true }.
 */
export async function removeFollower({
  targetId,
  csrfToken = null,
  wwwClaim = null,
  ajaxHash = null,
  fetchFn = globalThis.fetch,
}) {
  requireCsrf(csrfToken);
  const body = new URLSearchParams({
    user_id: String(targetId),
    container_module: 'profile',
    radio_type: 'wifi-none',
  }).toString();
  const args = { body, csrfToken, wwwClaim, ajaxHash, fetchFn };
  try {
    await postFriendshipWrite({
      url: `${API_BASE}/friendships/remove_follower/${targetId}/`,
      ...args,
    });
  } catch (err) {
    if (!shouldFallbackFollowEndpoint(err)) throw err;
    await postFriendshipWrite({
      url: `https://www.instagram.com/web/friendships/${targetId}/remove_follower/`,
      ...args,
      body: null,
    });
  }
  return { removed: true };
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

/**
 * Extra coverage added by QA. Focuses on gaps in the original suites:
 * mid-scan and mid-backoff cancellation, 5xx retries, per-page retry budget,
 * cookie decode fallback, delay randomization bounds, CSV \r escaping, and
 * a few small mapping fallbacks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCookie, fetchFollowListPage, fetchUserInfo, fetchAllFollows } from '../src/lib/ig-api.js';
import { toUserRecord, compareFollowLists, toCsv } from '../src/lib/compare.js';

/* ---------- helpers (mirrors ig-api.test.mjs) ---------- */

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const rawUser = (pk, username = `user${pk}`) => ({
  pk,
  username,
  full_name: '',
  profile_pic_url: '',
  is_private: false,
  is_verified: false,
});

function pageBody(users, nextMaxId) {
  const body = { status: 'ok', users };
  if (nextMaxId !== undefined) body.next_max_id = nextMaxId;
  return body;
}

function fetchQueue(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    if (responses.length === 0) throw new Error('fetchQueue exhausted');
    const next = responses.shift();
    return typeof next === 'function' ? next() : next;
  };
  fn.calls = calls;
  return fn;
}

const noDelay = () => {
  const calls = [];
  const fn = async (ms) => calls.push(ms);
  fn.calls = calls;
  return fn;
};

/* ---------- cancellation in the middle of a scan ---------- */

test('fetchAllFollows honours cancellation between pages', async () => {
  const fetchFn = fetchQueue([
    jsonResponse(pageBody([rawUser(1)], 'A')),
    jsonResponse(pageBody([rawUser(2)], undefined)), // must never be requested
  ]);
  let cancelled = false;
  await assert.rejects(
    fetchAllFollows({
      userId: '42',
      kind: 'followers',
      fetchFn,
      delayFn: noDelay(),
      onProgress: () => {
        cancelled = true; // cancel as soon as the first page lands
      },
      isCancelled: () => cancelled,
    }),
    { code: 'cancelled' }
  );
  assert.equal(fetchFn.calls.length, 1, 'no request after cancellation');
});

test('fetchAllFollows honours cancellation during a retry backoff', async () => {
  const fetchFn = fetchQueue([
    jsonResponse({}, { status: 429 }),
    jsonResponse(pageBody([rawUser(1)], undefined)), // must never be requested
  ]);
  let cancelled = false;
  const delayFn = async (ms) => {
    cancelled = true; // user cancels while we sleep out the rate limit
    return ms;
  };
  await assert.rejects(
    fetchAllFollows({
      userId: '42',
      kind: 'followers',
      fetchFn,
      delayFn,
      retryBaseMs: 1,
      isCancelled: () => cancelled,
    }),
    { code: 'cancelled' }
  );
  assert.equal(fetchFn.calls.length, 1, 'cancelled backoff must not retry the request');
});

/* ---------- retry behaviour ---------- */

test('fetchAllFollows retries retriable HTTP 5xx errors', async () => {
  const fetchFn = fetchQueue([
    jsonResponse({}, { status: 503 }),
    jsonResponse(pageBody([rawUser(1)], undefined)),
  ]);
  const delayFn = noDelay();
  const users = await fetchAllFollows({
    userId: '42',
    kind: 'followers',
    fetchFn,
    delayFn,
    retryBaseMs: 250,
  });
  assert.deepEqual(users.map((u) => u.pk), ['1']);
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(delayFn.calls, [250]);
});

test('fetchAllFollows retry budget resets on each page', async () => {
  // With maxRetries: 1, one 429 per page must still succeed on every page —
  // the attempt counter is per page, not cumulative across the scan.
  const fetchFn = fetchQueue([
    jsonResponse({}, { status: 429 }),
    jsonResponse(pageBody([rawUser(1)], 'A')),
    jsonResponse({}, { status: 429 }),
    jsonResponse(pageBody([rawUser(2)], undefined)),
  ]);
  const delayFn = noDelay();
  const users = await fetchAllFollows({
    userId: '42',
    kind: 'followers',
    fetchFn,
    delayFn,
    maxRetries: 1,
    retryBaseMs: 1000,
    minDelayMs: 900,
    maxDelayMs: 900,
    randomFn: () => 0,
  });
  assert.deepEqual(users.map((u) => u.pk), ['1', '2']);
  assert.equal(fetchFn.calls.length, 4);
  // retry backoff (attempt 0 again), page delay, retry backoff (attempt 0 again)
  assert.deepEqual(delayFn.calls, [1000, 900, 1000]);
});

/* ---------- between-page delay randomization ---------- */

test('fetchAllFollows spreads the between-page delay across [min, max)', async () => {
  const fetchFn = fetchQueue([
    jsonResponse(pageBody([rawUser(1)], 'A')),
    jsonResponse(pageBody([rawUser(2)], undefined)),
  ]);
  const delayFn = noDelay();
  await fetchAllFollows({
    userId: '42',
    kind: 'followers',
    fetchFn,
    delayFn,
    minDelayMs: 900,
    maxDelayMs: 2200,
    randomFn: () => 0.5,
  });
  assert.deepEqual(delayFn.calls, [900 + Math.floor(0.5 * (2200 - 900))]); // 1550
});

/* ---------- fetchFollowListPage / fetchUserInfo details ---------- */

test('fetchFollowListPage forwards a custom pageSize as count', async () => {
  const fetchFn = fetchQueue([jsonResponse(pageBody([], undefined))]);
  await fetchFollowListPage({ userId: '42', kind: 'following', pageSize: 25, fetchFn });
  assert.ok(fetchFn.calls[0].url.includes('count=25'));
});

test('fetchFollowListPage omits the csrf header when no token is given', async () => {
  const fetchFn = fetchQueue([jsonResponse(pageBody([], undefined))]);
  await fetchFollowListPage({ userId: '42', kind: 'following', fetchFn });
  assert.ok(!('x-csrftoken' in fetchFn.calls[0].options.headers));
});

test('fetchUserInfo tolerates a body without a user object', async () => {
  const fetchFn = fetchQueue([jsonResponse({})]);
  const info = await fetchUserInfo({ userId: '42', fetchFn });
  assert.deepEqual(info, { username: null, followerCount: null, followingCount: null });
});

/* ---------- getCookie fallback ---------- */

test('getCookie returns the raw value when percent-decoding fails', () => {
  // '%E0%A4%A' is a truncated escape sequence: decodeURIComponent throws.
  assert.equal(getCookie('n', 'n=%E0%A4%A'), '%E0%A4%A');
});

test('getCookie trims whitespace around cookie pairs', () => {
  assert.equal(getCookie('b', 'a=1;   b=2 ;c=3'), '2');
});

/* ---------- compare.js edges ---------- */

test('toUserRecord falls back to id when pk is null', () => {
  assert.equal(toUserRecord({ pk: null, id: 7 }).pk, '7');
  assert.equal(toUserRecord(null).pk, '');
});

test('compareFollowLists reports full mutuality when the lists match', () => {
  const rec = (pk, username) => ({
    pk: String(pk),
    username,
    fullName: '',
    profilePicUrl: '',
    isPrivate: false,
    isVerified: false,
  });
  const list = [rec(1, 'a'), rec(2, 'b')];
  const { unfollowers, fans, mutualCount } = compareFollowLists(list, [...list].reverse());
  assert.deepEqual(unfollowers, []);
  assert.deepEqual(fans, []);
  assert.equal(mutualCount, 2);
});

test('toCsv quotes values containing carriage returns', () => {
  const csv = toCsv([
    {
      pk: '1',
      username: 'alice',
      fullName: 'line1\rline2',
      profilePicUrl: '',
      isPrivate: false,
      isVerified: false,
    },
  ]);
  assert.ok(csv.includes('"line1\rline2"'));
});

test('toCsv handles null-ish fields without crashing', () => {
  const csv = toCsv([
    { pk: '1', username: 'alice', fullName: null, profilePicUrl: '', isPrivate: false, isVerified: false },
  ]);
  assert.ok(csv.split('\r\n')[1].startsWith('alice,,https://www.instagram.com/alice/'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IG_APP_ID,
  IgApiError,
  getCookie,
  fetchFollowListPage,
  fetchUserInfo,
  fetchAllFollows,
} from '../src/lib/ig-api.js';

/* ---------- helpers ---------- */

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

/** fetch mock that records calls and pops queued responses. */
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

/* ---------- getCookie ---------- */

test('getCookie finds a cookie among others', () => {
  assert.equal(getCookie('ds_user_id', 'mid=xyz; ds_user_id=12345; csrftoken=abc'), '12345');
});

test('getCookie returns null when missing and handles empty string', () => {
  assert.equal(getCookie('nope', 'a=1; b=2'), null);
  assert.equal(getCookie('a', ''), null);
});

test('getCookie decodes percent-encoding and keeps = inside values', () => {
  assert.equal(getCookie('n', 'n=a%3Db'), 'a=b');
  assert.equal(getCookie('tok', 'tok=abc=def'), 'abc=def');
});

/* ---------- fetchFollowListPage ---------- */

test('fetchFollowListPage builds the right URL and headers', async () => {
  const fetchFn = fetchQueue([jsonResponse(pageBody([rawUser(1)], 'CURSOR'))]);
  const page = await fetchFollowListPage({
    userId: '42',
    kind: 'followers',
    csrfToken: 'CSRF',
    fetchFn,
  });
  const { url, options } = fetchFn.calls[0];
  assert.ok(url.startsWith('https://www.instagram.com/api/v1/friendships/42/followers/?'));
  assert.ok(url.includes('count=100'));
  assert.ok(url.includes('search_surface=follow_list_page'));
  assert.ok(!url.includes('max_id='));
  assert.equal(options.headers['x-ig-app-id'], IG_APP_ID);
  assert.equal(options.headers['x-csrftoken'], 'CSRF');
  assert.equal(options.credentials, 'include');
  assert.equal(page.users.length, 1);
  assert.equal(page.nextMaxId, 'CURSOR');
});

test('fetchFollowListPage passes max_id and omits search_surface for following', async () => {
  const fetchFn = fetchQueue([jsonResponse(pageBody([], undefined))]);
  const page = await fetchFollowListPage({ userId: '42', kind: 'following', maxId: 'M1', fetchFn });
  const { url } = fetchFn.calls[0];
  assert.ok(url.includes('/following/'));
  assert.ok(url.includes('max_id=M1'));
  assert.ok(!url.includes('search_surface'));
  assert.equal(page.nextMaxId, null);
});

test('fetchFollowListPage rejects unknown kinds', async () => {
  await assert.rejects(fetchFollowListPage({ userId: '1', kind: 'friends', fetchFn: fetchQueue([]) }), {
    code: 'bad_kind',
  });
});

test('fetchFollowListPage maps HTTP statuses to typed errors', async () => {
  for (const [status, code, retriable] of [
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [500, 'http', true],
    [404, 'http', false],
  ]) {
    const fetchFn = fetchQueue([jsonResponse({}, { status })]);
    try {
      await fetchFollowListPage({ userId: '1', kind: 'followers', fetchFn });
      assert.fail(`expected HTTP ${status} to throw`);
    } catch (err) {
      assert.ok(err instanceof IgApiError, `HTTP ${status} should be IgApiError`);
      assert.equal(err.code, code, `HTTP ${status} code`);
      assert.equal(err.retriable, retriable, `HTTP ${status} retriable`);
    }
  }
});

test('fetchFollowListPage rejects unexpected body shapes', async () => {
  await assert.rejects(
    fetchFollowListPage({ userId: '1', kind: 'followers', fetchFn: fetchQueue([jsonResponse({ status: 'fail' })]) }),
    { code: 'bad_body' }
  );
  const nonJson = { ok: true, status: 200, json: async () => { throw new Error('nope'); } };
  await assert.rejects(
    fetchFollowListPage({ userId: '1', kind: 'followers', fetchFn: fetchQueue([nonJson]) }),
    { code: 'bad_body' }
  );
});

/* ---------- fetchUserInfo ---------- */

test('fetchUserInfo maps profile fields', async () => {
  const fetchFn = fetchQueue([
    jsonResponse({ user: { username: 'alice', follower_count: 10, following_count: 20 } }),
  ]);
  const info = await fetchUserInfo({ userId: '42', fetchFn });
  assert.deepEqual(info, { username: 'alice', followerCount: 10, followingCount: 20 });
  assert.ok(fetchFn.calls[0].url.includes('/users/42/info/'));
});

test('fetchUserInfo throws on auth failures', async () => {
  await assert.rejects(fetchUserInfo({ userId: '42', fetchFn: fetchQueue([jsonResponse({}, { status: 403 })]) }), {
    code: 'auth',
  });
});

/* ---------- fetchAllFollows ---------- */

test('fetchAllFollows paginates through cursors and delays between pages', async () => {
  const fetchFn = fetchQueue([
    jsonResponse(pageBody([rawUser(1), rawUser(2)], 'A')),
    jsonResponse(pageBody([rawUser(3)], 'B')),
    jsonResponse(pageBody([rawUser(4)], undefined)),
  ]);
  const delayFn = noDelay();
  const progress = [];
  const users = await fetchAllFollows({
    userId: '42',
    kind: 'following',
    fetchFn,
    delayFn,
    randomFn: () => 0,
    minDelayMs: 900,
    maxDelayMs: 2200,
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(users.map((u) => u.pk), ['1', '2', '3', '4']);
  assert.equal(fetchFn.calls.length, 3);
  assert.ok(fetchFn.calls[1].url.includes('max_id=A'));
  assert.ok(fetchFn.calls[2].url.includes('max_id=B'));
  // one delay between each pair of pages, none after the last
  assert.deepEqual(delayFn.calls, [900, 900]);
  assert.deepEqual(progress.map((p) => p.fetched), [2, 3, 4]);
});

test('fetchAllFollows dedupes users repeated across pages', async () => {
  const fetchFn = fetchQueue([
    jsonResponse(pageBody([rawUser(1), rawUser(2)], 'A')),
    jsonResponse(pageBody([rawUser(2), rawUser(3)], undefined)),
  ]);
  const users = await fetchAllFollows({ userId: '42', kind: 'followers', fetchFn, delayFn: noDelay() });
  assert.deepEqual(users.map((u) => u.pk), ['1', '2', '3']);
});

test('fetchAllFollows retries rate limits with exponential backoff', async () => {
  const fetchFn = fetchQueue([
    jsonResponse({}, { status: 429 }),
    jsonResponse({}, { status: 429 }),
    jsonResponse(pageBody([rawUser(1)], undefined)),
  ]);
  const delayFn = noDelay();
  const progress = [];
  const users = await fetchAllFollows({
    userId: '42',
    kind: 'followers',
    fetchFn,
    delayFn,
    retryBaseMs: 1000,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(users.length, 1);
  assert.equal(fetchFn.calls.length, 3);
  assert.deepEqual(delayFn.calls, [1000, 2000]); // 1000 * 2^0, 1000 * 2^1
  assert.ok(progress.some((p) => p.retryingInMs === 1000));
});

test('fetchAllFollows gives up after maxRetries', async () => {
  const fetchFn = fetchQueue([
    jsonResponse({}, { status: 429 }),
    jsonResponse({}, { status: 429 }),
  ]);
  await assert.rejects(
    fetchAllFollows({ userId: '42', kind: 'followers', fetchFn, delayFn: noDelay(), maxRetries: 1, retryBaseMs: 1 }),
    { code: 'rate_limit' }
  );
  assert.equal(fetchFn.calls.length, 2); // initial + 1 retry
});

test('fetchAllFollows does not retry non-retriable errors', async () => {
  const fetchFn = fetchQueue([jsonResponse({}, { status: 401 })]);
  await assert.rejects(
    fetchAllFollows({ userId: '42', kind: 'followers', fetchFn, delayFn: noDelay() }),
    { code: 'auth' }
  );
  assert.equal(fetchFn.calls.length, 1);
});

test('fetchAllFollows honours cancellation before any request', async () => {
  const fetchFn = fetchQueue([]);
  await assert.rejects(
    fetchAllFollows({ userId: '42', kind: 'followers', fetchFn, delayFn: noDelay(), isCancelled: () => true }),
    { code: 'cancelled' }
  );
  assert.equal(fetchFn.calls.length, 0);
});

test('fetchAllFollows stops when Instagram repeats a cursor', async () => {
  const fetchFn = fetchQueue([
    jsonResponse(pageBody([rawUser(1)], 'X')),
    jsonResponse(pageBody([rawUser(2)], 'X')),
    jsonResponse(pageBody([rawUser(3)], 'X')), // must never be requested
  ]);
  const users = await fetchAllFollows({ userId: '42', kind: 'followers', fetchFn, delayFn: noDelay() });
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(users.map((u) => u.pk), ['1', '2']);
});

test('fetchAllFollows respects the maxPages safety cap', async () => {
  const fetchFn = fetchQueue([
    jsonResponse(pageBody([rawUser(1)], 'A')),
    jsonResponse(pageBody([rawUser(2)], 'B')),
    jsonResponse(pageBody([rawUser(3)], 'C')),
  ]);
  const users = await fetchAllFollows({
    userId: '42',
    kind: 'followers',
    fetchFn,
    delayFn: noDelay(),
    maxPages: 2,
  });
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(users.length, 2);
});

test('fetchAllFollows skips records without a pk', async () => {
  const fetchFn = fetchQueue([jsonResponse(pageBody([rawUser(1), { username: 'ghost' }], undefined))]);
  const users = await fetchAllFollows({ userId: '42', kind: 'followers', fetchFn, delayFn: noDelay() });
  assert.deepEqual(users.map((u) => u.username), ['user1']);
});

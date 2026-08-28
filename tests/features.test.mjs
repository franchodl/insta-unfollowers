import test from 'node:test';
import assert from 'node:assert/strict';
import { diffScans, formatSyncSummary, toCsv } from '../src/lib/compare.js';
import { setFollowState, removeFollower, IG_APP_ID } from '../src/lib/ig-api.js';

const rec = (pk, username, fullName = '') => ({
  pk: String(pk),
  username,
  fullName,
  profilePicUrl: '',
  isPrivate: false,
  isVerified: false,
});

const scanOf = (over = {}) => ({
  userId: '42',
  username: 'me',
  timestamp: 1_000_000,
  followerCount: 100,
  followingCount: 120,
  mutualCount: 90,
  unfollowers: [rec(1, 'a'), rec(2, 'b')],
  fans: [rec(9, 'z')],
  ...over,
});

/* ---------- diffScans ---------- */

test('diffScans returns null without a previous scan', () => {
  assert.equal(diffScans(null, scanOf()), null);
  assert.equal(diffScans(undefined, scanOf()), null);
});

test('diffScans finds new and resolved unfollowers plus count deltas', () => {
  const previous = scanOf({ unfollowers: [rec(1, 'a'), rec(3, 'c')], followerCount: 95, followingCount: 125 });
  const current = scanOf({ timestamp: 2_000_000 });
  const diff = diffScans(previous, current);
  assert.deepEqual(diff.newUnfollowers.map((u) => u.username), ['b']); // pk 2 is new
  assert.equal(diff.resolvedUnfollowerCount, 1); // pk 3 resolved
  assert.equal(diff.followerDelta, 5);
  assert.equal(diff.followingDelta, -5);
  assert.equal(diff.unfollowerDelta, 0);
  assert.equal(diff.fanDelta, 0);
  assert.equal(diff.sinceTimestamp, 1_000_000);
});

test('diffScans with identical scans reports no changes', () => {
  const diff = diffScans(scanOf(), scanOf({ timestamp: 2_000_000 }));
  assert.equal(diff.newUnfollowers.length, 0);
  assert.equal(diff.resolvedUnfollowerCount, 0);
  assert.equal(diff.followerDelta, 0);
});

/* ---------- formatSyncSummary ---------- */

test('formatSyncSummary without a diff only prints totals', () => {
  const lines = formatSyncSummary(scanOf({ diff: null }));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('Followers: 100'));
  assert.ok(!lines[0].includes('('));
  assert.ok(lines[1].includes("Don't follow back: 2"));
});

test('formatSyncSummary prints signed deltas and new unfollowers', () => {
  const scan = scanOf();
  scan.diff = {
    sinceTimestamp: 1,
    newUnfollowers: [rec(2, 'b')],
    resolvedUnfollowerCount: 0,
    followerDelta: 5,
    followingDelta: -2,
    unfollowerDelta: 1,
    fanDelta: 0,
  };
  const lines = formatSyncSummary(scan);
  assert.ok(lines[0].includes('Followers: 100 (+5)'));
  assert.ok(lines[0].includes('Following: 120 (−2)'));
  assert.ok(lines[1].includes('(±0)'));
  assert.equal(lines[2], '1 new unfollower: @b');
});

test('formatSyncSummary caps the listed new unfollowers at five', () => {
  const scan = scanOf();
  scan.diff = {
    sinceTimestamp: 1,
    newUnfollowers: [rec(1, 'a'), rec(2, 'b'), rec(3, 'c'), rec(4, 'd'), rec(5, 'e'), rec(6, 'f'), rec(7, 'g')],
    followerDelta: 0,
    followingDelta: 0,
    unfollowerDelta: 7,
    fanDelta: 0,
  };
  const line = formatSyncSummary(scan)[2];
  assert.ok(line.startsWith('7 new unfollowers: @a, @b, @c, @d, @e and 2 more'));
});

test('formatSyncSummary celebrates zero new unfollowers when a diff exists', () => {
  const scan = scanOf();
  scan.diff = { sinceTimestamp: 1, newUnfollowers: [], followerDelta: 0, followingDelta: 0, unfollowerDelta: 0, fanDelta: 0 };
  assert.ok(formatSyncSummary(scan)[2].includes('No new unfollowers'));
});

/* ---------- CSV formula injection ---------- */

test('toCsv neutralizes leading spreadsheet formula characters', () => {
  const users = [
    rec(1, 'alice', '=HYPERLINK("https://evil.example","x")'),
    rec(2, 'bob', '+1 (555) 000'),
    rec(3, 'cat', '@handle'),
    rec(4, 'dan', '-dash name'),
    rec(5, 'eve', 'normal = safe'),
  ];
  const csv = toCsv(users);
  assert.ok(csv.includes(`'=HYPERLINK`));
  assert.ok(csv.includes(`'+1 (555) 000`));
  assert.ok(csv.includes(`'@handle`));
  assert.ok(csv.includes(`'-dash name`));
  assert.ok(csv.includes(',normal = safe,')); // only a *leading* char triggers it
});

/* ---------- setFollowState ---------- */

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function htmlResponse(html, { status = 200, url = '', redirected = false } = {}) {
  const make = () => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => html,
    clone: () => make(),
  });
  return make();
}

test('setFollowState unfollow POSTs to friendships/destroy with the web-client headers', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ status: 'ok', friendship_status: { following: false } });
  };
  const result = await setFollowState({
    targetId: '77',
    follow: false,
    csrfToken: 'CSRF',
    wwwClaim: 'CLAIM',
    fetchFn,
  });
  assert.equal(result.following, false);
  assert.equal(calls[0].url, 'https://www.instagram.com/api/v1/friendships/destroy/77/');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-ig-app-id'], IG_APP_ID);
  assert.equal(calls[0].options.headers['x-csrftoken'], 'CSRF');
  assert.equal(calls[0].options.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(calls[0].options.headers['x-ig-www-claim'], 'CLAIM');
  assert.equal(calls[0].options.headers['x-instagram-ajax'], '1');
  assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].options.body, 'user_id=77&container_module=profile_unfollow&radio_type=wifi-none');
  assert.equal(calls[0].options.credentials, 'include');
});

test('setFollowState follow POSTs to friendships/create', async () => {
  let seenUrl = null;
  const fetchFn = async (url) => {
    seenUrl = url;
    return jsonResponse({ status: 'ok', friendship_status: { following: true } });
  };
  const result = await setFollowState({ targetId: '77', follow: true, csrfToken: 'CSRF', fetchFn });
  assert.equal(result.following, true);
  assert.equal(seenUrl, 'https://www.instagram.com/api/v1/friendships/create/77/');
});

test('setFollowState requires a CSRF token and does not fire the request without one', async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return jsonResponse({ status: 'ok' });
  };
  await assert.rejects(setFollowState({ targetId: '1', follow: false, fetchFn }), {
    code: 'auth',
  });
  assert.equal(called, false);
});

test('setFollowState falls back to the web unfollow endpoint when destroy returns HTML', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/destroy/')) return htmlResponse('<!DOCTYPE html><html><body>Log in</body></html>');
    return jsonResponse({ status: 'ok', friendship_status: { following: false } });
  };
  const result = await setFollowState({ targetId: '1', follow: false, csrfToken: 'CSRF', fetchFn });
  assert.equal(result.following, false);
  assert.equal(calls[0], 'https://www.instagram.com/api/v1/friendships/destroy/1/');
  assert.equal(calls[1], 'https://www.instagram.com/api/v1/web/friendships/1/unfollow/');
});

test('setFollowState retries follow on HTTP 404 using the web follow endpoint', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/friendships/create/')) return jsonResponse({}, { status: 404 });
    return jsonResponse({ status: 'ok', friendship_status: { following: true } });
  };
  const result = await setFollowState({ targetId: '9', follow: true, csrfToken: 'CSRF', fetchFn });
  assert.equal(result.following, true);
  assert.equal(calls[0], 'https://www.instagram.com/api/v1/friendships/create/9/');
  assert.equal(calls[1], 'https://www.instagram.com/api/v1/web/friendships/9/follow/');
});

test('setFollowState keeps trying later follow URLs when earlier ones 404', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/friendships/create/') || url.includes('/web/friendships/')) {
      return jsonResponse({}, { status: 404 });
    }
    return jsonResponse({ status: 'ok', friendship_status: { following: true } });
  };
  const result = await setFollowState({ targetId: '9', follow: true, csrfToken: 'CSRF', fetchFn });
  assert.equal(result.following, true);
  assert.ok(calls.some((url) => url.includes('/friendships/follow/9/')));
});

test('setFollowState turns an HTML login/redirect response into an actionable auth error', async () => {
  const fetchFn = async () => htmlResponse('<!DOCTYPE html><html><body>Log in</body></html>');
  await assert.rejects(
    setFollowState({ targetId: '1', follow: false, csrfToken: 'CSRF', fetchFn }),
    (err) => err.code === 'auth' && /login or security-check/i.test(err.message)
  );
});

test('setFollowState does not fall back on rate limits', async () => {
  let calls = 0;
  await assert.rejects(
    setFollowState({
      targetId: '1',
      follow: false,
      csrfToken: 'CSRF',
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({}, { status: 429 });
      },
    }),
    { code: 'rate_limit' }
  );
  assert.equal(calls, 1);
});

test('setFollowState surfaces auth, rate-limit and bad-body errors', async () => {
  await assert.rejects(
    setFollowState({
      targetId: '1',
      follow: false,
      csrfToken: 'CSRF',
      fetchFn: async () => jsonResponse({}, { status: 403 }),
    }),
    { code: 'auth' }
  );
  await assert.rejects(
    setFollowState({
      targetId: '1',
      follow: false,
      csrfToken: 'CSRF',
      fetchFn: async () => jsonResponse({}, { status: 429 }),
    }),
    { code: 'rate_limit' }
  );
  await assert.rejects(
    setFollowState({
      targetId: '1',
      follow: false,
      csrfToken: 'CSRF',
      fetchFn: async () => jsonResponse({ status: 'fail' }),
    }),
    { code: 'bad_body' }
  );
});

test('removeFollower POSTs to friendships/remove_follower with the web-client headers', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ status: 'ok', friendship_status: { followed_by: false } });
  };
  const result = await removeFollower({
    targetId: '77',
    csrfToken: 'CSRF',
    wwwClaim: 'CLAIM',
    fetchFn,
  });
  assert.equal(result.removed, true);
  assert.equal(calls[0].url, 'https://www.instagram.com/api/v1/friendships/remove_follower/77/');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-ig-app-id'], IG_APP_ID);
  assert.equal(calls[0].options.headers['x-csrftoken'], 'CSRF');
  assert.equal(calls[0].options.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(calls[0].options.headers['x-ig-www-claim'], 'CLAIM');
  assert.equal(calls[0].options.headers['x-instagram-ajax'], '1');
  assert.equal(calls[0].options.body, 'user_id=77&container_module=profile&radio_type=wifi-none');
  assert.equal(calls[0].options.credentials, 'include');
});

test('removeFollower falls back to the web endpoint when the v1 call returns HTML', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/api/v1/')) return htmlResponse('<!DOCTYPE html><html><body>Log in</body></html>');
    return jsonResponse({ status: 'ok' });
  };
  const result = await removeFollower({ targetId: '1', csrfToken: 'CSRF', fetchFn });
  assert.equal(result.removed, true);
  assert.equal(calls[0], 'https://www.instagram.com/api/v1/friendships/remove_follower/1/');
  assert.equal(calls[1], 'https://www.instagram.com/web/friendships/1/remove_follower/');
});

test('removeFollower requires a CSRF token and does not fire the request without one', async () => {
  let called = false;
  await assert.rejects(
    removeFollower({
      targetId: '1',
      fetchFn: async () => {
        called = true;
        return jsonResponse({ status: 'ok' });
      },
    }),
    { code: 'auth' }
  );
  assert.equal(called, false);
});

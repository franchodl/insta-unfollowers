import test from 'node:test';
import assert from 'node:assert/strict';
import { toUserRecord, compareFollowLists, filterUsers, toCsv } from '../src/lib/compare.js';

const rec = (pk, username, fullName = '') => ({
  pk: String(pk),
  username,
  fullName,
  profilePicUrl: '',
  isPrivate: false,
  isVerified: false,
});

test('toUserRecord maps raw Instagram fields and stringifies pk', () => {
  const record = toUserRecord({
    pk: 12345,
    username: 'alice',
    full_name: 'Alice A.',
    profile_pic_url: 'https://cdn.example/pic.jpg',
    is_private: 1,
    is_verified: false,
  });
  assert.deepEqual(record, {
    pk: '12345',
    username: 'alice',
    fullName: 'Alice A.',
    profilePicUrl: 'https://cdn.example/pic.jpg',
    isPrivate: true,
    isVerified: false,
  });
});

test('toUserRecord falls back to id and tolerates missing fields', () => {
  assert.equal(toUserRecord({ id: '9' }).pk, '9');
  const empty = toUserRecord({});
  assert.equal(empty.pk, '');
  assert.equal(empty.username, '');
  assert.equal(empty.fullName, '');
  assert.equal(empty.isPrivate, false);
});

test('toUserRecord reads alternate profile pic and pk fields', () => {
  assert.equal(
    toUserRecord({ pk_id: '88', hd_profile_pic_url_info: { url: 'https://cdn.example/hd.jpg' } }).profilePicUrl,
    'https://cdn.example/hd.jpg'
  );
  assert.equal(toUserRecord({ pk: { pk: '7' } }).pk, '7');
});

test('toUserRecord prefers string pk_id over numeric pk', () => {
  assert.equal(toUserRecord({ pk: 1, pk_id: '999' }).pk, '999');
  assert.equal(toUserRecord({ pk: Number.MAX_SAFE_INTEGER + 2, pk_id: '9007199254740993' }).pk, '9007199254740993');
});

test('compareFollowLists finds unfollowers, fans and mutual count', () => {
  const following = [rec(1, 'zoe'), rec(2, 'bob'), rec(3, 'cat')];
  const followers = [rec(2, 'bob'), rec(3, 'cat'), rec(4, 'dan')];
  const { unfollowers, fans, mutualCount } = compareFollowLists(following, followers);
  assert.deepEqual(unfollowers.map((u) => u.username), ['zoe']);
  assert.deepEqual(fans.map((u) => u.username), ['dan']);
  assert.equal(mutualCount, 2);
});

test('compareFollowLists sorts results by username', () => {
  const following = [rec(1, 'zoe'), rec(2, 'amy'), rec(3, 'mia')];
  const { unfollowers } = compareFollowLists(following, []);
  assert.deepEqual(unfollowers.map((u) => u.username), ['amy', 'mia', 'zoe']);
});

test('compareFollowLists with empty inputs', () => {
  const none = compareFollowLists([], []);
  assert.deepEqual(none, { unfollowers: [], fans: [], mutualCount: 0 });
  const all = compareFollowLists([rec(1, 'a')], []);
  assert.equal(all.unfollowers.length, 1);
  assert.equal(all.mutualCount, 0);
});

test('filterUsers matches username and full name, case-insensitive', () => {
  const users = [rec(1, 'Alice_W', 'Alice Wonder'), rec(2, 'bob', 'Robert')];
  assert.deepEqual(filterUsers(users, 'alice').map((u) => u.pk), ['1']);
  assert.deepEqual(filterUsers(users, 'ROBERT').map((u) => u.pk), ['2']);
  assert.deepEqual(filterUsers(users, '  wonder  ').map((u) => u.pk), ['1']);
  assert.equal(filterUsers(users, '').length, 2);
  assert.equal(filterUsers(users, null).length, 2);
  assert.equal(filterUsers(users, 'nope').length, 0);
});

test('toCsv writes a header and escapes quotes, commas and newlines', () => {
  const users = [
    { ...rec(1, 'alice', 'He said "hi", ok'), isPrivate: true },
    rec(2, 'bob', 'line1\nline2'),
  ];
  const csv = toCsv(users);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'username,full_name,profile_url,is_private,is_verified');
  assert.equal(lines[1], 'alice,"He said ""hi"", ok",https://www.instagram.com/alice/,true,false');
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('toCsv URL-encodes unusual usernames', () => {
  const csv = toCsv([rec(1, 'weird/name')]);
  assert.ok(csv.includes('https://www.instagram.com/weird%2Fname/'));
});

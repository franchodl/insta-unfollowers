/**
 * Pure data helpers — no browser APIs, so everything here is unit-testable
 * in Node (see tests/compare.test.mjs).
 */

/** Normalize a raw Instagram API user object into the record we store. */
export function toUserRecord(raw) {
  const pk = raw?.pk ?? raw?.id ?? '';
  return {
    pk: pk === null || pk === undefined ? '' : String(pk),
    username: raw?.username ?? '',
    fullName: raw?.full_name ?? '',
    profilePicUrl: raw?.profile_pic_url ?? '',
    isPrivate: Boolean(raw?.is_private),
    isVerified: Boolean(raw?.is_verified),
  };
}

/**
 * Compare the two lists by user id (pk).
 * - unfollowers: accounts you follow that don't follow you back
 * - fans: accounts that follow you but you don't follow back
 */
export function compareFollowLists(following, followers) {
  const followerPks = new Set(followers.map((u) => u.pk));
  const followingPks = new Set(following.map((u) => u.pk));
  const byUsername = (a, b) => a.username.localeCompare(b.username);
  const unfollowers = following.filter((u) => !followerPks.has(u.pk)).sort(byUsername);
  const fans = followers.filter((u) => !followingPks.has(u.pk)).sort(byUsername);
  return { unfollowers, fans, mutualCount: following.length - unfollowers.length };
}

/**
 * Compare a new scan against the previous one for the same account.
 * Returns null when there is no previous scan to diff against.
 */
export function diffScans(previous, current) {
  if (!previous) return null;
  const prevUnfollowerPks = new Set((previous.unfollowers ?? []).map((u) => u.pk));
  const currentUnfollowers = current.unfollowers ?? [];
  const currentPks = new Set(currentUnfollowers.map((u) => u.pk));
  return {
    sinceTimestamp: previous.timestamp ?? null,
    newUnfollowers: currentUnfollowers.filter((u) => !prevUnfollowerPks.has(u.pk)),
    resolvedUnfollowerCount: [...prevUnfollowerPks].filter((pk) => !currentPks.has(pk)).length,
    followerDelta: (current.followerCount ?? 0) - (previous.followerCount ?? 0),
    followingDelta: (current.followingCount ?? 0) - (previous.followingCount ?? 0),
    unfollowerDelta: currentUnfollowers.length - (previous.unfollowers?.length ?? 0),
    fanDelta: (current.fans?.length ?? 0) - (previous.fans?.length ?? 0),
  };
}

/**
 * Human-readable summary of a finished scan, as an array of lines — used by
 * both the popup toast and the system notification.
 */
export function formatSyncSummary(scan, diff = scan?.diff ?? null) {
  const delta = (d) => {
    if (d === null || d === undefined || !diff) return '';
    if (d === 0) return ' (±0)';
    return d > 0 ? ` (+${d.toLocaleString()})` : ` (−${Math.abs(d).toLocaleString()})`;
  };
  const lines = [
    `Followers: ${Number(scan.followerCount ?? 0).toLocaleString()}${delta(diff?.followerDelta)} · Following: ${Number(scan.followingCount ?? 0).toLocaleString()}${delta(diff?.followingDelta)}`,
    `Don't follow back: ${(scan.unfollowers?.length ?? 0).toLocaleString()}${delta(diff?.unfollowerDelta)} · Fans: ${(scan.fans?.length ?? 0).toLocaleString()}${delta(diff?.fanDelta)}`,
  ];
  if (diff) {
    const fresh = diff.newUnfollowers ?? [];
    if (fresh.length > 0) {
      const names = fresh.slice(0, 5).map((u) => `@${u.username}`).join(', ');
      const extra = fresh.length > 5 ? ` and ${fresh.length - 5} more` : '';
      lines.push(`${fresh.length} new unfollower${fresh.length === 1 ? '' : 's'}: ${names}${extra}`);
    } else {
      lines.push('No new unfollowers since the last sync. 🎉');
    }
  }
  return lines;
}

/** Case-insensitive filter on username and full name. */
export function filterUsers(users, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return users;
  return users.filter(
    (u) => u.username.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q)
  );
}

/** Render user records as an RFC 4180 CSV string. */
export function toCsv(users) {
  const escape = (value) => {
    let s = String(value ?? '');
    // Neutralize spreadsheet formula injection: full names are
    // attacker-controlled and =/+/-/@ prefixes execute in Excel/Sheets.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [['username', 'full_name', 'profile_url', 'is_private', 'is_verified'].join(',')];
  for (const u of users) {
    lines.push(
      [
        u.username,
        u.fullName,
        `https://www.instagram.com/${encodeURIComponent(u.username)}/`,
        u.isPrivate,
        u.isVerified,
      ]
        .map(escape)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

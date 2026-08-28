/**
 * Popup UI. Talks to the content script in the user's Instagram tab, which
 * does the actual scanning; reads results from chrome.storage.local. All
 * user-provided strings (usernames, full names) are rendered exclusively via
 * textContent / DOM APIs — never innerHTML.
 */
import { filterUsers, toCsv, formatSyncSummary } from '../lib/compare.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'no-tab', 'empty', 'scanning', 'error', 'results', 'settings'];
const RENDER_CHUNK = 200;
const DEFAULT_SETTINGS = { dailySync: false, notifyResults: true };

const state = {
  tabId: null, // Instagram tab we talk to, or null when none is open
  connected: false, // whether the content script answered
  userId: null, // logged-in ds_user_id reported by the content script
  content: null, // last scan-state object broadcast by the content script
  scan: null, // scan results shown in the results view
  whitelist: new Set(), // pks the user chose to ignore
  unfollowedSet: new Set(), // pks unfollowed from the popup since the last scan
  removedFanSet: new Set(), // pks removed as followers from the Fans tab since the last scan
  newUnfollowerPks: new Set(), // pks that are new since the previous scan
  settings: { ...DEFAULT_SETTINGS },
  inSettings: false,
  activeTab: 'unfollowers',
  query: '',
  showIgnored: false,
  renderLimit: RENDER_CHUNK,
  cancelPending: false,
};

async function init() {
  showView('loading');
  wireEvents();

  state.tabId = await findInstagramTabId();
  if (state.tabId !== null) {
    const res = await getContentState(state.tabId);
    if (res?.ok) {
      state.connected = true;
      state.userId = res.userId ?? null;
      state.content = res.state ?? null;
    }
  }
  await reloadStoredData();
  route();

  // Safety net: if a scan died with its tab (reload/close), the badge can be
  // left showing the scanning indicator — clear it when nothing is scanning.
  try {
    const text = await chrome.action.getBadgeText({});
    if (text === '…' && state.content?.status !== 'scanning') {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // Badge is cosmetic only.
  }
}

let eventsWired = false;
function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  $('btn-open-instagram').addEventListener('click', () =>
    chrome.tabs.create({ url: 'https://www.instagram.com/' })
  );
  $('btn-scan').addEventListener('click', startScan);
  $('btn-rescan').addEventListener('click', startScan);
  $('btn-retry').addEventListener('click', () => (state.connected ? startScan() : init()));
  $('btn-cancel').addEventListener('click', cancelScan);
  $('btn-export').addEventListener('click', exportCsv);
  $('tab-unfollowers').addEventListener('click', () => switchTab('unfollowers'));
  $('tab-fans').addEventListener('click', () => switchTab('fans'));
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    state.renderLimit = RENDER_CHUNK;
    renderList();
  });
  $('show-ignored').addEventListener('change', (e) => {
    state.showIgnored = e.target.checked;
    state.renderLimit = RENDER_CHUNK;
    renderList();
  });
  $('btn-settings').addEventListener('click', () => {
    state.inSettings = !state.inSettings;
    if (state.inSettings) renderSettings();
    else route();
  });
  $('btn-settings-back').addEventListener('click', () => {
    state.inSettings = false;
    route();
  });
  $('opt-daily-sync').addEventListener('change', (e) => saveSetting('dailySync', e.target.checked));
  $('opt-notify').addEventListener('change', (e) => saveSetting('notifyResults', e.target.checked));
  $('btn-clear-data').addEventListener('click', clearAllData);
}

/* ---------- Tab discovery & messaging ---------- */

async function findInstagramTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  const usable = tabs.filter((t) => !t.discarded);
  if (usable.length === 0) return null;
  const active = usable.find((t) => t.active);
  const best = active ?? usable.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  return best.id ?? null;
}

async function getContentState(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'IU_GET_STATE' });
  } catch {
    // Content script not there yet (e.g. extension installed after the tab
    // loaded) — inject it and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/page-bridge.js'],
        world: 'MAIN',
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
      return await chrome.tabs.sendMessage(tabId, { type: 'IU_GET_STATE' });
    } catch {
      return null;
    }
  }
}

async function sendToTab(message) {
  if (state.tabId === null) return null;
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch {
    return null;
  }
}

function onRuntimeMessage(message, sender) {
  if (message?.type !== 'IU_STATE_CHANGED') return;
  if (sender?.tab?.id !== undefined && state.tabId !== null && sender.tab.id !== state.tabId) return;
  state.content = message.state;
  if (message.state?.status === 'done') {
    state.userId = message.state.summary?.userId ?? state.userId;
    reloadStoredData().then(() => {
      route();
      if (state.scan) showToast(formatSyncSummary(state.scan));
    });
  } else {
    route();
  }
}

/* ---------- Storage ---------- */

async function reloadStoredData() {
  const {
    scans = {},
    lastScanUserId = null,
    whitelists = {},
    unfollowed = {},
    removedFans = {},
    settings = {},
  } = await chrome.storage.local.get([
    'scans',
    'lastScanUserId',
    'whitelists',
    'unfollowed',
    'removedFans',
    'settings',
  ]);
  const uid = state.userId ?? lastScanUserId;
  state.scan = uid !== null && uid !== undefined ? (scans[uid] ?? null) : null;
  state.whitelist = new Set(state.scan ? (whitelists[state.scan.userId] ?? []) : []);
  state.unfollowedSet = new Set(state.scan ? (unfollowed[state.scan.userId] ?? []) : []);
  state.removedFanSet = new Set(state.scan ? (removedFans[state.scan.userId] ?? []) : []);
  state.newUnfollowerPks = new Set((state.scan?.diff?.newUnfollowers ?? []).map((u) => u.pk));
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSetting(key, value) {
  state.settings[key] = value;
  await chrome.storage.local.set({ settings: state.settings });
}

async function toggleIgnore(pk) {
  const uid = state.scan?.userId;
  if (uid === null || uid === undefined) return;
  if (state.whitelist.has(pk)) state.whitelist.delete(pk);
  else state.whitelist.add(pk);
  const { whitelists = {} } = await chrome.storage.local.get('whitelists');
  whitelists[uid] = [...state.whitelist];
  await chrome.storage.local.set({ whitelists });
  renderList();
}

/* ---------- Actions ---------- */

async function startScan() {
  if (state.tabId === null) state.tabId = await findInstagramTabId();
  if (state.tabId === null) {
    showView('no-tab');
    return;
  }
  if (!state.connected) {
    const res = await getContentState(state.tabId);
    if (res?.ok) {
      state.connected = true;
      state.userId = res.userId ?? state.userId;
    }
  }
  const res = await sendToTab({ type: 'IU_START_SCAN' });
  if (!res?.ok) {
    renderError(res?.error ?? 'Could not start the scan. Reload your Instagram tab and try again.');
    return;
  }
  state.cancelPending = false;
  state.content = {
    status: 'scanning',
    phase: 'profile',
    progress: { following: { fetched: 0, total: null }, followers: { fetched: 0, total: null } },
    retryingInMs: null,
  };
  route();
}

async function cancelScan() {
  state.cancelPending = true;
  $('btn-cancel').disabled = true;
  $('btn-cancel').textContent = 'Cancelling…';
  await sendToTab({ type: 'IU_CANCEL_SCAN' });
}

function switchTab(tab) {
  state.activeTab = tab;
  state.renderLimit = RENDER_CHUNK;
  renderTabs();
  renderList();
}

function exportCsv() {
  const users = visibleUsers();
  const blob = new Blob([toCsv(users)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date(state.scan?.timestamp ?? Date.now()).toISOString().slice(0, 10);
  a.download = `instagram-${state.activeTab}-${stamp}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Routing & rendering ---------- */

function route() {
  const c = state.content;
  if (c?.status !== 'scanning') state.cancelPending = false;
  if (state.inSettings) return renderSettings();
  if (c?.status === 'scanning') return renderScanning();
  if (c?.status === 'error') return renderError(c.error);
  if (state.scan) return renderResults();
  if (state.tabId === null) return showView('no-tab');
  if (!state.connected) {
    return renderError('Could not reach your Instagram tab. Reload instagram.com and try again.');
  }
  if (!state.userId) {
    return renderError('You don’t appear to be logged in to Instagram in that tab. Log in, then try again.');
  }
  showView('empty');
}

function showView(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
}

function renderError(message) {
  showView('error');
  $('error-message').textContent = message || 'Unknown error.';
}

function renderScanning() {
  showView('scanning');
  const c = state.content ?? {};
  const phaseLabels = {
    profile: 'Checking your profile…',
    following: 'Fetching accounts you follow…',
    followers: 'Fetching your followers…',
    comparing: 'Comparing lists…',
  };
  $('scan-phase').textContent = phaseLabels[c.phase] ?? 'Scanning…';
  updateBar('following', c.progress?.following);
  updateBar('followers', c.progress?.followers);
  $('scan-note').textContent = c.retryingInMs
    ? `Instagram asked us to slow down — retrying in ${Math.round(c.retryingInMs / 1000)}s. This is normal for larger accounts.`
    : 'Fetching gently to respect Instagram’s rate limits — large accounts can take a few minutes. You can close this popup; the scan keeps running.';
  const cancel = $('btn-cancel');
  cancel.disabled = state.cancelPending;
  cancel.textContent = state.cancelPending ? 'Cancelling…' : 'Cancel';
}

function updateBar(kind, progress) {
  const bar = $(`bar-${kind}`);
  const label = $(`${kind}-count`);
  const fetched = progress?.fetched ?? 0;
  const total = progress?.total ?? null;
  if (total) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.min(100, (fetched / total) * 100)}%`;
    label.textContent = `${fetched.toLocaleString()} / ${total.toLocaleString()}`;
  } else {
    bar.classList.add('indeterminate');
    label.textContent = fetched ? fetched.toLocaleString() : '';
  }
}

function renderResults() {
  showView('results');
  const scan = state.scan;
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch {
    // Badge is cosmetic; never let it break rendering.
  }
  $('subtitle').textContent = scan.username
    ? `@${scan.username} · scanned ${timeAgo(scan.timestamp)}`
    : `Scanned ${timeAgo(scan.timestamp)}`;
  renderSummary(scan);
  renderDiffBanner(scan);
  renderTabs();
  renderList();
}

function renderDiffBanner(scan) {
  const banner = $('diff-banner');
  const diff = scan.diff;
  if (!diff) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const since = diff.sinceTimestamp ? timeAgo(diff.sinceTimestamp) : 'the previous scan';
  const fresh = diff.newUnfollowers?.length ?? 0;
  if (fresh > 0) {
    banner.className = 'diff-banner warn';
    banner.textContent = `${fresh} new unfollower${fresh === 1 ? '' : 's'} since the last scan (${since}).`;
  } else {
    banner.className = 'diff-banner';
    banner.textContent = `No new unfollowers since the last scan (${since}).`;
  }
}

function renderSettings() {
  showView('settings');
  $('opt-daily-sync').checked = Boolean(state.settings.dailySync);
  $('opt-notify').checked = Boolean(state.settings.notifyResults);
}

let clearArmedTimer = null;
async function clearAllData() {
  const btn = $('btn-clear-data');
  // Two-step confirmation (window.confirm is unreliable in extension popups).
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.textContent = 'Click again to delete everything';
    clearTimeout(clearArmedTimer);
    clearArmedTimer = setTimeout(() => {
      btn.dataset.armed = 'false';
      btn.textContent = 'Delete all stored data';
    }, 4000);
    return;
  }
  clearTimeout(clearArmedTimer);
  btn.dataset.armed = 'false';
  btn.textContent = 'Delete all stored data';
  await chrome.storage.local.clear();
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch {
    // Badge is cosmetic only.
  }
  state.inSettings = false;
  showToast(['All locally stored scan data was deleted.']);
  init();
}

let toastTimer = null;
function showToast(lines, isError = false) {
  const toast = $('toast');
  toast.textContent = '';
  for (const line of lines) {
    const p = document.createElement('div');
    p.textContent = line;
    toast.append(p);
  }
  toast.className = isError ? 'toast error' : 'toast';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 7000);
}

function renderSummary(scan) {
  const container = $('summary');
  container.textContent = '';
  const chips = [
    ['Following', scan.followingCount],
    ['Followers', scan.followerCount],
    ['Mutuals', scan.mutualCount],
    ['Don’t follow back', scan.unfollowers?.length ?? 0],
  ];
  for (const [label, value] of chips) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const v = document.createElement('strong');
    v.textContent = Number(value ?? 0).toLocaleString();
    const l = document.createElement('span');
    l.textContent = label;
    chip.append(v, l);
    container.append(chip);
  }
}

function listFor(tab) {
  return (tab === 'unfollowers' ? state.scan?.unfollowers : state.scan?.fans) ?? [];
}

function renderTabs() {
  $('tab-unfollowers').classList.toggle('active', state.activeTab === 'unfollowers');
  $('tab-fans').classList.toggle('active', state.activeTab === 'fans');
  $('count-unfollowers').textContent = String(
    listFor('unfollowers').filter((u) => !state.whitelist.has(u.pk) && !state.unfollowedSet.has(u.pk)).length
  );
  $('count-fans').textContent = String(
    listFor('fans').filter((u) => !state.whitelist.has(u.pk) && !state.removedFanSet.has(u.pk)).length
  );
}

function hiddenByAction(u) {
  if (state.activeTab === 'unfollowers') return state.unfollowedSet.has(u.pk);
  if (state.activeTab === 'fans') return state.removedFanSet.has(u.pk);
  return false;
}

function visibleUsers() {
  let users = listFor(state.activeTab);
  users = users.filter((u) => !hiddenByAction(u));
  if (!state.showIgnored) users = users.filter((u) => !state.whitelist.has(u.pk));
  return filterUsers(users, state.query);
}

function renderList() {
  const container = $('list');
  container.textContent = '';
  const users = visibleUsers();
  if (users.length === 0) {
    const rawList = listFor(state.activeTab);
    const afterAction = rawList.filter((u) => !hiddenByAction(u));
    const allIgnored =
      afterAction.length > 0 && afterAction.every((u) => state.whitelist.has(u.pk));
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = state.query
      ? 'No matches.'
      : afterAction.length === 0 && rawList.length > 0
        ? state.activeTab === 'fans'
          ? 'You have removed everyone on this list. 🎉'
          : 'You have unfollowed everyone on this list. 🎉'
        : allIgnored
          ? `All ${afterAction.length.toLocaleString()} account${afterAction.length === 1 ? '' : 's'} here are ignored.`
          : state.activeTab === 'unfollowers'
            ? 'Everyone you follow follows you back. 🎉'
            : 'No accounts here.';
    container.append(empty);
  }
  for (const u of users.slice(0, state.renderLimit)) container.append(userRow(u));
  if (users.length > state.renderLimit) {
    const remaining = users.length - state.renderLimit;
    const more = document.createElement('button');
    more.className = 'btn btn-secondary btn-more';
    more.textContent = `Show ${Math.min(RENDER_CHUNK, remaining)} more (${remaining.toLocaleString()} left)`;
    more.addEventListener('click', () => {
      state.renderLimit += RENDER_CHUNK;
      renderList();
    });
    container.append(more);
  }
  renderTabs(); // keep pill counts in sync after ignore toggles
}

function userRow(u) {
  const ignored = state.whitelist.has(u.pk);
  const row = document.createElement('div');
  row.className = `row${ignored ? ' row-ignored' : ''}`;

  row.append(avatarFor(u));

  const info = document.createElement('div');
  info.className = 'row-info';
  const link = document.createElement('a');
  link.href = `https://www.instagram.com/${encodeURIComponent(u.username)}/`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'row-username';
  link.textContent = `@${u.username}`;
  info.append(link);
  if (state.activeTab === 'unfollowers' && state.newUnfollowerPks.has(u.pk)) {
    const badge = document.createElement('span');
    badge.className = 'badge-new';
    badge.textContent = 'NEW';
    badge.title = 'New unfollower since your previous scan';
    link.append(badge);
  }
  const flags = [u.isVerified ? '✔ verified' : null, u.isPrivate ? 'private' : null]
    .filter(Boolean)
    .join(' · ');
  const metaText = [u.fullName, flags].filter(Boolean).join(' · ');
  if (metaText) {
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = metaText;
    info.append(meta);
  }
  row.append(info);

  if (state.activeTab === 'unfollowers') {
    const followBtn = document.createElement('button');
    followBtn.className = 'btn-follow';
    followBtn.textContent = 'Unfollow';
    followBtn.title = `Unfollow @${u.username} on Instagram`;
    followBtn.addEventListener('click', () => unfollowUser(u, followBtn, row));
    row.append(followBtn);
  } else if (state.activeTab === 'fans') {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-follow';
    removeBtn.textContent = 'Remove';
    removeBtn.title = `Remove @${u.username} as a follower`;
    removeBtn.addEventListener('click', () => removeFan(u, removeBtn, row));
    row.append(removeBtn);
  }

  const btn = document.createElement('button');
  btn.className = 'btn-ghost';
  btn.textContent = ignored ? 'Unignore' : 'Ignore';
  btn.title = ignored
    ? 'Show this account in results again'
    : 'Hide this account from results (e.g. celebrities you don’t expect to follow back)';
  btn.addEventListener('click', () => toggleIgnore(u.pk));
  row.append(btn);

  return row;
}

/**
 * Unfollow one account via the content script (one click, one request). On
 * success the row fades out and is removed from the list; the pk is remembered
 * (until the next scan) so it doesn't reappear on re-render.
 */
async function unfollowUser(u, btn, row) {
  btn.disabled = true;
  btn.textContent = 'Unfollowing…';
  if (state.tabId === null) state.tabId = await findInstagramTabId();
  const res = await sendToTab({ type: 'IU_SET_FOLLOW', pk: u.pk, follow: false });
  if (!res?.ok) {
    btn.disabled = false;
    btn.textContent = 'Unfollow';
    showToast([res?.error ?? 'Could not reach your Instagram tab. Open instagram.com and try again.'], true);
    return;
  }
  state.unfollowedSet.add(u.pk);
  const uid = state.scan?.userId;
  if (uid !== null && uid !== undefined) {
    const { unfollowed = {} } = await chrome.storage.local.get('unfollowed');
    unfollowed[uid] = [...state.unfollowedSet];
    await chrome.storage.local.set({ unfollowed });
  }
  showToast([`Unfollowed @${u.username}.`]);
  fadeAndRemoveRow(row, () => renderList());
}

/**
 * Remove one follower via the content script (one click, one request). On
 * success the row fades out like Unfollow; the pk is remembered until the
 * next scan so it doesn't reappear on re-render.
 */
async function removeFan(u, btn, row) {
  btn.disabled = true;
  btn.textContent = 'Removing…';
  if (state.tabId === null) state.tabId = await findInstagramTabId();
  const res = await sendToTab({ type: 'IU_REMOVE_FOLLOWER', pk: u.pk });
  if (!res?.ok) {
    btn.disabled = false;
    btn.textContent = 'Remove';
    showToast([res?.error ?? 'Could not reach your Instagram tab. Open instagram.com and try again.'], true);
    return;
  }
  state.removedFanSet.add(u.pk);
  const uid = state.scan?.userId;
  if (uid !== null && uid !== undefined) {
    const { removedFans = {} } = await chrome.storage.local.get('removedFans');
    removedFans[uid] = [...state.removedFanSet];
    await chrome.storage.local.set({ removedFans });
  }
  showToast([`Removed @${u.username}.`]);
  fadeAndRemoveRow(row, () => renderList());
}

/** Fade/collapse a row out, then run `done` (which re-renders the list). */
function fadeAndRemoveRow(row, done) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (reduce) {
    row.remove();
    done?.();
    return;
  }
  // Lock current height so the collapse transition has somewhere to go from.
  row.style.maxHeight = `${row.offsetHeight}px`;
  // Next frame: add the class that transitions height/opacity to zero.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => row.classList.add('row-removing'));
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    row.remove();
    done?.();
  };
  row.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 500); // fallback if transitionend never fires
}

// Only load avatars from Instagram's own CDNs, in case a scan record ever
// carries a tampered URL.
function isInstagramCdnUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname.endsWith('.cdninstagram.com') || url.hostname.endsWith('.fbcdn.net'))
    );
  } catch {
    return false;
  }
}

function avatarFor(u) {
  const wrap = document.createElement('div');
  wrap.className = 'avatar';
  const fallback = () => {
    wrap.textContent = (u.username?.[0] ?? '?').toUpperCase();
  };
  if (isInstagramCdnUrl(u.profilePicUrl)) {
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.addEventListener('error', () => {
      img.remove();
      fallback();
    });
    img.src = u.profilePicUrl;
    wrap.append(img);
  } else {
    fallback();
  }
  return wrap;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

init();

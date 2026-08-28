/**
 * Content script — runs on instagram.com and performs the actual scan using
 * the page's own logged-in session. The scan lives here (not in the popup) so
 * it keeps running even if the popup closes.
 *
 * Loaded both via the manifest and, as a fallback, programmatically from the
 * popup. The versioned guard lets a newer extension load replace a stale
 * listener left behind after chrome://extensions → Reload (the Instagram tab
 * is not always refreshed).
 */
(() => {
  const CONTENT_VERSION = 5;
  if (window.__iuContentVersion >= CONTENT_VERSION) return;
  window.__iuContentVersion = CONTENT_VERSION;
  window.__instaUnfollowersLoaded = true;

  // Library modules are proper ES modules (listed in web_accessible_resources)
  // so the same files are unit-tested in Node.
  const libReady = (async () => {
    const [api, compare] = await Promise.all([
      import(chrome.runtime.getURL('src/lib/ig-api.js')),
      import(chrome.runtime.getURL('src/lib/compare.js')),
    ]);
    return { api, compare };
  })();

  const idleState = () => ({
    status: 'idle', // idle | scanning | done | error
    phase: null, // profile | following | followers | comparing
    progress: {
      following: { fetched: 0, total: null },
      followers: { fetched: 0, total: null },
    },
    retryingInMs: null,
    error: null,
    summary: null,
  });

  let state = idleState();
  let cancelRequested = false;

  function setState(patch) {
    state = { ...state, ...patch };
    // Popup and service worker may or may not be listening; ignore failures.
    chrome.runtime.sendMessage({ type: 'IU_STATE_CHANGED', state })?.catch?.(() => {});
  }

  function setProgress(kind, { fetched, retryingInMs = null }) {
    setState({
      phase: kind,
      retryingInMs,
      progress: { ...state.progress, [kind]: { ...state.progress[kind], fetched } },
    });
  }

  const HISTORY_LIMIT = 120;

  async function saveScan(scan, compare) {
    const { scans = {}, histories = {}, unfollowed = {}, removedFans = {}, followedBack = {} } =
      await chrome.storage.local.get(['scans', 'histories', 'unfollowed', 'removedFans', 'followedBack']);
    scan.diff = compare.diffScans(scans[scan.userId] ?? null, scan);
    scans[scan.userId] = scan;
    const history = histories[scan.userId] ?? [];
    history.push({
      timestamp: scan.timestamp,
      followerCount: scan.followerCount,
      followingCount: scan.followingCount,
      unfollowerCount: scan.unfollowers.length,
      fanCount: scan.fans.length,
      newUnfollowerCount: scan.diff?.newUnfollowers.length ?? 0,
    });
    histories[scan.userId] = history.slice(-HISTORY_LIMIT);
    // A fresh scan reflects the real follow state, so per-row unfollow /
    // remove-follower / follow-back toggles from the previous results are stale.
    unfollowed[scan.userId] = [];
    removedFans[scan.userId] = [];
    followedBack[scan.userId] = [];
    await chrome.storage.local.set({
      scans,
      histories,
      unfollowed,
      removedFans,
      followedBack,
      lastScanUserId: scan.userId,
    });
  }

  function writeHeaders(api) {
    const headers = {
      'x-ig-app-id': api.IG_APP_ID,
      'x-asbd-id': api.IG_ASBD_ID,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    };
    const csrf = api.getCookie('csrftoken');
    if (csrf) headers['x-csrftoken'] = csrf;
    const claim = getWwwClaim();
    if (claim) headers['x-ig-www-claim'] = claim;
    headers['x-instagram-ajax'] = getRolloutHash();
    return headers;
  }

  async function setFollow(pk, follow, username) {
    const { api } = await libReady;
    if (!api.getCookie('ds_user_id')) {
      return { ok: false, error: 'You are not logged in to Instagram in this tab.' };
    }
    if (!pk && !username) {
      return { ok: false, error: 'Missing account id — rescan and try again.' };
    }
    try {
      const result = await pageWorldFriendship(follow ? 'follow' : 'unfollow', pk, writeHeaders(api), username);
      if (!result?.ok) return { ok: false, error: result?.error ?? 'Instagram rejected the request.' };
      return { ok: true, following: result.following };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  async function removeFan(pk) {
    const { api } = await libReady;
    if (!api.getCookie('ds_user_id')) {
      return { ok: false, error: 'You are not logged in to Instagram in this tab.' };
    }
    if (!pk) {
      return { ok: false, error: 'Missing account id — rescan and try again.' };
    }
    try {
      const result = await pageWorldFriendship('remove', pk, writeHeaders(api));
      if (!result?.ok) return { ok: false, error: result?.error ?? 'Instagram rejected the request.' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  function getWwwClaim() {
    try {
      return window.sessionStorage.getItem('www-claim-v2') || window.localStorage.getItem('www-claim-v2');
    } catch {
      return null;
    }
  }

  function getRolloutHash() {
    try {
      const nodes = document.querySelectorAll('script[type="application/json"]');
      for (const node of nodes) {
        const text = node.textContent;
        if (!text || !text.includes('rollout_hash')) continue;
        const found = text.match(/"rollout_hash"\s*:\s*"([^"]+)"/);
        if (found) return found[1];
      }
    } catch {
      // DOM shape varies; the MAIN-world bridge also fills this header.
    }
    return '1';
  }

  let pageBridgeReady = false;

  function postToPage(payload) {
    window.postMessage(payload, window.location.origin);
  }

  function pingPageBridge(timeoutMs) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(false);
      }, timeoutMs);
      function onMessage(event) {
        if (event.source !== window) return;
        if (event.data?.type !== 'IU_PAGE_PONG_V2' || event.data?.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(Number(event.data.version) >= 5);
      }
      window.addEventListener('message', onMessage);
      postToPage({ type: 'IU_PAGE_PING_V2', id });
    });
  }

  async function ensurePageBridge() {
    if (pageBridgeReady) return;
    if (await pingPageBridge(250)) {
      pageBridgeReady = true;
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: 'IU_INJECT_PAGE_BRIDGE' });
    } catch {
      // Service worker may still inject after waking; ping again below.
    }
    if (await pingPageBridge(1500)) {
      pageBridgeReady = true;
      return;
    }
    throw new Error('Could not reach Instagram in this tab. Reload the instagram.com tab and try again.');
  }

  async function pageWorldFriendship(action, targetId, headers, username) {
    await ensurePageBridge();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Instagram did not respond. Reload the instagram.com tab and try again.'));
      }, 40000);
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.type !== 'IU_PAGE_FRIENDSHIP_RESULT_V5' || data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(data);
      }
      window.addEventListener('message', onMessage);
      postToPage({
        type: 'IU_PAGE_FRIENDSHIP_V5',
        id,
        action,
        targetId: String(targetId || ''),
        username: String(username || ''),
        headers: headers || {},
      });
    });
  }

  async function runScan(source = 'manual') {
    const { api, compare } = await libReady;
    cancelRequested = false;

    const userId = api.getCookie('ds_user_id');
    if (!userId) {
      setState({ ...idleState(), status: 'error', error: 'You are not logged in to Instagram in this tab.' });
      return;
    }
    const csrfToken = api.getCookie('csrftoken');
    setState({ ...idleState(), status: 'scanning', phase: 'profile' });

    let profile = { username: null, followerCount: null, followingCount: null };
    try {
      profile = await api.fetchUserInfo({ userId, csrfToken });
    } catch {
      // Non-fatal: we only lose the progress totals and the username label.
    }
    setState({
      progress: {
        following: { fetched: 0, total: profile.followingCount },
        followers: { fetched: 0, total: profile.followerCount },
      },
    });

    const isCancelled = () => cancelRequested;
    try {
      const following = await api.fetchAllFollows({
        userId,
        kind: 'following',
        csrfToken,
        isCancelled,
        onProgress: (p) => setProgress('following', p),
      });
      const followers = await api.fetchAllFollows({
        userId,
        kind: 'followers',
        csrfToken,
        isCancelled,
        onProgress: (p) => setProgress('followers', p),
      });

      setState({ phase: 'comparing', retryingInMs: null });
      const { unfollowers, fans, mutualCount } = compare.compareFollowLists(following, followers);
      const scan = {
        userId,
        username: profile.username,
        timestamp: Date.now(),
        followingCount: following.length,
        followerCount: followers.length,
        mutualCount,
        unfollowers,
        fans,
      };
      await saveScan(scan, compare);
      setState({
        status: 'done',
        phase: null,
        summary: {
          userId,
          username: profile.username,
          timestamp: scan.timestamp,
          followingCount: following.length,
          followerCount: followers.length,
          mutualCount,
          unfollowerCount: unfollowers.length,
          fanCount: fans.length,
        },
      });
      chrome.runtime
        .sendMessage({
          type: 'IU_SCAN_COMPLETE',
          source,
          userId,
          unfollowerCount: unfollowers.length,
          newUnfollowerCount: scan.diff?.newUnfollowers.length ?? 0,
          summaryLines: compare.formatSyncSummary(scan),
        })
        ?.catch?.(() => {});
    } catch (err) {
      if (err?.code === 'cancelled') {
        setState(idleState());
      } else {
        setState({ status: 'error', phase: null, retryingInMs: null, error: err?.message ?? String(err) });
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'IU_GET_STATE_V5':
        libReady
          .then(({ api }) =>
            sendResponse({
              ok: true,
              state,
              userId: api.getCookie('ds_user_id'),
              version: CONTENT_VERSION,
            })
          )
          .catch(() =>
            sendResponse({ ok: false, error: 'Extension failed to initialise on this page. Reload the tab.' })
          );
        return true; // keep the message channel open for the async response
      case 'IU_START_SCAN_V5':
        if (state.status === 'scanning') {
          sendResponse({ ok: false, error: 'A scan is already running.' });
        } else {
          runScan(message.source === 'daily' ? 'daily' : 'manual');
          sendResponse({ ok: true });
        }
        return false;
      case 'IU_CANCEL_SCAN_V5':
        cancelRequested = true;
        sendResponse({ ok: true });
        return false;
      case 'IU_SET_FOLLOW_V5':
        setFollow(String(message.pk ?? ''), Boolean(message.follow), String(message.username ?? '')).then(
          sendResponse
        );
        return true;
      case 'IU_REMOVE_FOLLOWER_V5':
        removeFan(String(message.pk ?? '')).then(sendResponse);
        return true;
      default:
        return false;
    }
  });

  // Tell the service worker a fresh content script is alive in this tab: if a
  // scan was running here before a reload, it died — the badge must not stay
  // stuck on the scanning indicator.
  chrome.runtime.sendMessage({ type: 'IU_CONTENT_READY' })?.catch?.(() => {});
})();

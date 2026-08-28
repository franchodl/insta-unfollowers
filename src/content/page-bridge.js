/**
 * MAIN-world fetch bridge.
 *
 * Isolated-world content scripts send fetch() with a chrome-extension Origin,
 * and Instagram's write endpoints treat that as unauthenticated (they return
 * an HTML login/checkpoint page instead of JSON). Requests issued here are
 * same-origin with instagram.com, so the browser sets Origin/Referer itself.
 *
 * Talks to the isolated content script via window.postMessage. Only follow,
 * unfollow, and remove-follower actions are allowed — this is not a generic
 * fetch proxy.
 *
 * Message types are versioned (V2 fetch / V5 friendship) so a stale listener
 * from an earlier extension load — which this page cannot remove — ignores
 * the new traffic.
 */
(() => {
  const BRIDGE_VERSION = 5;
  const IG_ORIGIN = 'https://www.instagram.com';
  const IG_APP_ID = '936619743392459';
  const PING = 'IU_PAGE_PING_V2';
  const PONG = 'IU_PAGE_PONG_V2';
  const FETCH = 'IU_PAGE_FETCH_V2';
  const RESULT = 'IU_PAGE_FETCH_RESULT_V2';
  const FRIENDSHIP = 'IU_PAGE_FRIENDSHIP_V5';
  const FRIENDSHIP_RESULT = 'IU_PAGE_FRIENDSHIP_RESULT_V5';

  const FOLLOW_MUTATIONS = [
    'usePolarisFollowUserFollowMutation',
    'usePolarisFollowMutation',
    'PolarisFollowButtonFollowMutation',
    'PolarisProfileFollowMutation',
  ];
  const UNFOLLOW_MUTATIONS = [
    'usePolarisFollowUserUnfollowMutation',
    'usePolarisUnfollowMutation',
    'PolarisFollowButtonUnfollowMutation',
    'PolarisProfileUnfollowMutation',
  ];

  function isAllowedUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== IG_ORIGIN) return false;
      const path = parsed.pathname.replace(/\/+$/, '') + '/';
      return (
        /^\/api\/v1\/friendships\/(create|destroy|remove_follower|follow|unfollow)\/$/.test(path) ||
        /^\/api\/v1\/friendships\/(create|destroy|remove_follower|follow|unfollow)\/[^/]+\/$/.test(path) ||
        /^\/api\/v1\/web\/friendships\/[^/]+\/(follow|unfollow|remove_follower)\/$/.test(path) ||
        /^\/web\/friendships\/[^/]+\/(follow|unfollow|remove_follower)\/$/.test(path) ||
        /^\/api\/v1\/users\/web_profile_info\/$/.test(path) ||
        path === '/api/graphql/' ||
        path === '/graphql/query/'
      );
    } catch {
      return false;
    }
  }

  function cookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function rolloutHash() {
    try {
      const nodes = document.querySelectorAll('script[type="application/json"]');
      for (const node of nodes) {
        const text = node.textContent;
        if (!text || !text.includes('rollout_hash')) continue;
        const found = text.match(/"rollout_hash"\s*:\s*"([^"]+)"/);
        if (found) return found[1];
      }
    } catch {
      // DOM may be unavailable at document_start; caller sends a fallback.
    }
    return null;
  }

  function fillHeaders(incoming) {
    const headers = { ...(incoming && typeof incoming === 'object' ? incoming : {}) };
    if (!headers['x-csrftoken']) {
      const csrf = cookie('csrftoken');
      if (csrf) headers['x-csrftoken'] = csrf;
    }
    if (!headers['x-ig-www-claim']) {
      try {
        const claim = sessionStorage.getItem('www-claim-v2') || localStorage.getItem('www-claim-v2');
        if (claim) headers['x-ig-www-claim'] = claim;
      } catch {
        // sessionStorage may be blocked
      }
    }
    if (!headers['x-instagram-ajax']) {
      headers['x-instagram-ajax'] = rolloutHash() || '1';
    }
    return headers;
  }

  function scriptTexts() {
    const out = [];
    try {
      for (const node of document.querySelectorAll('script')) {
        const text = node.textContent;
        if (text && text.length < 8_000_000) out.push(text);
      }
    } catch {
      // DOM unavailable
    }
    return out;
  }

  function findJsonToken(label) {
    const re = new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\]]{0,240}"token"\\s*:\\s*"([^"]+)"`);
    for (const text of scriptTexts()) {
      if (!text.includes(label)) continue;
      const match = text.match(re);
      if (match) return match[1];
    }
    return '';
  }

  function findPersistedDocId(friendlyName, texts) {
    const escaped = friendlyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`"id"\\s*:\\s*"(\\d{10,})"\\s*,\\s*"metadata"[^\\]]{0,200}"name"\\s*:\\s*"${escaped}"`),
      new RegExp(`"${escaped}"[^\\]]{0,500}?"id"\\s*:\\s*"(\\d{10,})"`),
      new RegExp(`"id"\\s*:\\s*"(\\d{10,})"[^\\]]{0,500}"${escaped}"`),
      new RegExp(`${escaped}["'\\s,:{]+(?:id["'\\s:]+)?["'](\\d{13,})`),
    ];
    for (const text of texts) {
      if (!text.includes(friendlyName)) continue;
      for (const re of patterns) {
        const match = text.match(re);
        if (match) return { docId: match[1], name: friendlyName };
      }
    }
    return null;
  }

  async function loadBundleTexts() {
    const srcs = [];
    try {
      const fromPerf = performance
        .getEntriesByType('resource')
        .filter((entry) => entry.initiatorType === 'script' || /\.js(\?|$)/i.test(entry.name))
        .sort((a, b) => (b.transferSize || b.encodedBodySize || 0) - (a.transferSize || a.encodedBodySize || 0))
        .map((entry) => entry.name);
      srcs.push(...fromPerf);
    } catch {
      // performance API unavailable
    }
    try {
      for (const node of document.querySelectorAll('script[src]')) {
        if (node.src) srcs.push(node.src);
      }
    } catch {
      // DOM unavailable
    }
    const unique = [...new Set(srcs)].slice(0, 10);
    const texts = (
      await Promise.all(
        unique.map(async (src) => {
          try {
            const res = await fetch(src, { credentials: 'omit' });
            if (!res.ok) return '';
            const text = await res.text();
            return text && text.length < 12_000_000 && text.includes('Mutation') ? text : '';
          } catch {
            return '';
          }
        })
      )
    ).filter(Boolean);
    return texts;
  }

  async function discoverMutation(names, username) {
    for (const name of names) {
      const fromRequire = await loadRelayOperation(name);
      if (fromRequire) return fromRequire;
    }
    const inline = scriptTexts();
    for (const name of names) {
      const found = findPersistedDocId(name, inline);
      if (found) return found;
    }
    if (username) {
      const scraped = await scrapeProfileForMutation(username, names);
      if (scraped) return scraped;
    }
    const bundles = await loadBundleTexts();
    for (const name of names) {
      const found = findPersistedDocId(name, bundles);
      if (found) return found;
    }
    return null;
  }

  function loadRelayOperation(name) {
    const moduleId = name.endsWith('.graphql') ? name : `${name}.graphql`;
    return new Promise((resolve) => {
      const finish = (mod) => {
        const params = mod?.params || mod?.default?.params || mod;
        const docId = params?.id;
        if (docId) resolve({ docId: String(docId), name: params?.name || name });
        else resolve(null);
      };
      const timer = setTimeout(() => resolve(null), 600);
      try {
        if (typeof requireLazy === 'function') {
          requireLazy(
            [moduleId],
            (mod) => {
              clearTimeout(timer);
              finish(mod);
            },
            () => {
              clearTimeout(timer);
              resolve(null);
            }
          );
          return;
        }
      } catch {
        // requireLazy missing or rejected the module id
      }
      try {
        if (typeof require === 'function') {
          clearTimeout(timer);
          finish(require(moduleId));
          return;
        }
      } catch {
        // require() is not Instagram's module loader
      }
      clearTimeout(timer);
      resolve(null);
    });
  }

  async function scrapeProfileForMutation(username, names) {
    try {
      const res = await fetch(`${IG_ORIGIN}/${encodeURIComponent(username)}/`, {
        credentials: 'include',
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' },
      });
      if (!res.ok) return null;
      const html = await res.text();
      if (!html || html.length > 12_000_000) return null;
      for (const name of names) {
        const found = findPersistedDocId(name, [html]);
        if (found) return found;
      }
    } catch {
      // Profile HTML is a best-effort source for Relay doc ids.
    }
    return null;
  }

  async function resolveUserId(username, fallbackId, headers) {
    const fallback = String(fallbackId || '');
    const handle = String(username || '').replace(/^@/, '').trim();
    if (!handle || !/^[A-Za-z0-9._]{1,30}$/.test(handle)) return fallback;
    try {
      const url = `${IG_ORIGIN}/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'x-ig-app-id': headers['x-ig-app-id'] || IG_APP_ID,
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json',
        },
      });
      const json = await res.json();
      const user = json?.data?.user ?? json?.user ?? {};
      const id = user.pk_id || user.id || user.pk;
      if (id != null && /^\d{1,32}$/.test(String(id))) return String(id);
    } catch {
      // Keep the scanned id if the profile lookup fails.
    }
    return fallback;
  }

  function restAttempts(action, id) {
    const form = new URLSearchParams({
      user_id: id,
      container_module: action === 'unfollow' ? 'profile_unfollow' : 'profile',
      radio_type: 'wifi-none',
    }).toString();
    const formTarget = new URLSearchParams({
      target_user_id: id,
      container_module: action === 'unfollow' ? 'profile_unfollow' : 'profile',
      radio_type: 'wifi-none',
    }).toString();

    if (action === 'follow') {
      return [
        { url: `${IG_ORIGIN}/web/friendships/${id}/follow/`, body: null, style: 'web' },
        { url: `${IG_ORIGIN}/api/v1/web/friendships/${id}/follow/`, body: form, style: 'api' },
        { url: `${IG_ORIGIN}/api/v1/friendships/create/${id}/`, body: form, style: 'api' },
        { url: `${IG_ORIGIN}/api/v1/friendships/create/${id}/`, body: formTarget, style: 'api' },
        { url: `${IG_ORIGIN}/api/v1/friendships/follow/${id}/`, body: form, style: 'api' },
        { url: `${IG_ORIGIN}/api/v1/friendships/create/`, body: form, style: 'api' },
      ];
    }
    if (action === 'unfollow') {
      return [
        { url: `${IG_ORIGIN}/api/v1/friendships/destroy/${id}/`, body: form, style: 'api' },
        { url: `${IG_ORIGIN}/api/v1/web/friendships/${id}/unfollow/`, body: form, style: 'api' },
        { url: `${IG_ORIGIN}/web/friendships/${id}/unfollow/`, body: null, style: 'web' },
      ];
    }
    return [
      { url: `${IG_ORIGIN}/api/v1/friendships/remove_follower/${id}/`, body: form, style: 'api' },
      { url: `${IG_ORIGIN}/api/v1/web/friendships/${id}/remove_follower/`, body: form, style: 'api' },
      { url: `${IG_ORIGIN}/web/friendships/${id}/remove_follower/`, body: null, style: 'web' },
    ];
  }

  function headersFor(style, base) {
    if (style === 'web') {
      return {
        'x-csrftoken': base['x-csrftoken'],
        'x-instagram-ajax': base['x-instagram-ajax'] || '1',
        'x-requested-with': 'XMLHttpRequest',
      };
    }
    return { ...base };
  }

  function findFriendshipStatus(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (obj.friendship_status && typeof obj.friendship_status === 'object') {
      return obj.friendship_status;
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') {
        const found = findFriendshipStatus(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function interpretSuccess(json, action) {
    if (!json || typeof json !== 'object') return null;
    if (Array.isArray(json.errors) && json.errors.length) return null;
    const fs = findFriendshipStatus(json);
    if (fs) {
      if (action === 'remove') return { ok: true, removed: true };
      if (action === 'follow') {
        return { ok: true, following: Boolean(fs.following || fs.outgoing_request) };
      }
      return { ok: true, following: Boolean(fs.following) };
    }
    // Classic web REST: { status: "ok" } with no friendship_status.
    if (json.status === 'ok' && json.data == null) {
      if (action === 'remove') return { ok: true, removed: true };
      if (action === 'follow') return { ok: true, following: json.result !== 'requested' };
      return { ok: true, following: false };
    }
    return null;
  }

  async function postForm(url, headers, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: body || undefined,
      credentials: 'include',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, text, json };
  }

  async function tryGraphql(action, id, baseHeaders, username) {
    const names = action === 'unfollow' ? UNFOLLOW_MUTATIONS : FOLLOW_MUTATIONS;
    const found = await discoverMutation(names, username);
    if (!found) return null;

    const lsd = cookie('lsd') || findJsonToken('LSD');
    const dtsg = findJsonToken('DTSGInitialData') || findJsonToken('DTSGInitData');
    const variableSets = [
      { target_user_id: id, container_module: 'profile' },
      { user_id: id, container_module: 'profile' },
      { target_user_id: id },
    ];
    const urls = [`${IG_ORIGIN}/graphql/query`, `${IG_ORIGIN}/api/graphql`];

    for (const variables of variableSets) {
      const body = new URLSearchParams({
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: found.name,
        variables: JSON.stringify(variables),
        server_timestamps: 'true',
        doc_id: found.docId,
      });
      if (lsd) body.set('lsd', lsd);
      if (dtsg) body.set('fb_dtsg', dtsg);

      const headers = {
        ...baseHeaders,
        'content-type': 'application/x-www-form-urlencoded',
        'x-fb-friendly-name': found.name,
      };
      if (lsd) headers['x-fb-lsd'] = lsd;

      for (const url of urls) {
        const { res, json } = await postForm(url, headers, body.toString());
        if (res.status === 429) {
          return { ok: false, status: 429, error: 'Instagram is rate-limiting requests.' };
        }
        const parsed = interpretSuccess(json, action);
        if (parsed) return { ...parsed, status: res.status };
      }
    }
    return null;
  }

  async function runFriendship(action, targetId, username, incomingHeaders) {
    const headers = fillHeaders(incomingHeaders);
    headers['x-ig-app-id'] = headers['x-ig-app-id'] || IG_APP_ID;
    const id = await resolveUserId(username, targetId, headers);
    if (!/^\d{1,32}$/.test(id)) {
      return { ok: false, error: 'Missing account id — rescan and try again.' };
    }
    if (action !== 'follow' && action !== 'unfollow' && action !== 'remove') {
      return { ok: false, error: 'Unknown Instagram action.' };
    }

    if (!headers['x-csrftoken']) {
      return {
        ok: false,
        error: 'Missing Instagram security token. Reload your instagram.com tab and try again.',
      };
    }

    let lastStatus = 0;
    for (const attempt of restAttempts(action, id)) {
      const reqHeaders = headersFor(attempt.style, headers);
      if (attempt.body) reqHeaders['content-type'] = 'application/x-www-form-urlencoded';
      const { res, json } = await postForm(attempt.url, reqHeaders, attempt.body);
      lastStatus = res.status;
      if (res.status === 429) {
        return { ok: false, status: 429, error: 'Instagram is rate-limiting requests.' };
      }
      const parsed = interpretSuccess(json, action);
      if (parsed) return { ...parsed, status: res.status };
    }

    if (action === 'follow' || action === 'unfollow') {
      const gql = await tryGraphql(action, id, headers, username);
      if (gql) return gql;
    }

    if (lastStatus === 401 || lastStatus === 403) {
      return {
        ok: false,
        status: lastStatus,
        error: 'Instagram rejected the request — make sure you are logged in.',
      };
    }
    const verb = action === 'follow' ? 'follow' : action === 'unfollow' ? 'unfollow' : 'remove';
    return {
      ok: false,
      status: lastStatus,
      error:
        lastStatus === 404
          ? `Instagram could not ${verb} this account (HTTP 404). Reload the instagram.com tab, then Rescan and try again.`
          : `Instagram returned HTTP ${lastStatus || 'error'}.`,
    };
  }

  function reply(id, payload) {
    window.postMessage({ type: RESULT, id, ...payload }, IG_ORIGIN);
  }

  async function onMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === PING && data.id) {
      window.postMessage({ type: PONG, id: data.id, version: BRIDGE_VERSION }, IG_ORIGIN);
      return;
    }

    if (data.type === FRIENDSHIP && data.id) {
      try {
        const result = await runFriendship(data.action, data.targetId, data.username, data.headers);
        window.postMessage({ type: FRIENDSHIP_RESULT, id: data.id, ...result }, IG_ORIGIN);
      } catch (err) {
        window.postMessage(
          {
            type: FRIENDSHIP_RESULT,
            id: data.id,
            ok: false,
            error: String(err?.message ?? err),
          },
          IG_ORIGIN
        );
      }
      return;
    }

    if (data.type !== FETCH || !data.id) return;
    if (typeof data.url !== 'string' || !isAllowedUrl(data.url)) {
      reply(data.id, { error: 'Blocked unexpected Instagram URL.' });
      return;
    }

    try {
      const res = await fetch(data.url, {
        method: data.method || 'POST',
        headers: fillHeaders(data.headers),
        body: data.body || undefined,
        credentials: 'include',
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      reply(data.id, {
        ok: res.ok,
        status: res.status,
        url: res.url,
        redirected: res.redirected,
        text,
        json,
      });
    } catch (err) {
      reply(data.id, { error: String(err?.message ?? err) });
    }
  }

  window.__iuPageBridgeHandler = onMessage;
  if (!window.__iuPageBridgeDispatching) {
    window.__iuPageBridgeDispatching = true;
    window.addEventListener('message', (event) => {
      window.__iuPageBridgeHandler?.(event);
    });
  }
  window.__iuPageBridge = true;
  window.__iuPageBridgeVersion = BRIDGE_VERSION;
})();

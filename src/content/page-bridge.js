/**
 * MAIN-world fetch bridge.
 *
 * Isolated-world content scripts send fetch() with a chrome-extension Origin,
 * and Instagram's write endpoints treat that as unauthenticated (they return
 * an HTML login/checkpoint page instead of JSON). Requests issued here are
 * same-origin with instagram.com, so the browser sets Origin/Referer itself.
 *
 * Talks to the isolated content script via window.postMessage. Only follow,
 * unfollow, and remove-follower URLs are allowed — this is not a generic
 * fetch proxy.
 *
 * Message types are versioned (V2) so a stale listener from an earlier
 * extension load — which this page cannot remove — ignores the new traffic.
 */
(() => {
  const BRIDGE_VERSION = 2;
  const IG_ORIGIN = 'https://www.instagram.com';
  const PING = 'IU_PAGE_PING_V2';
  const PONG = 'IU_PAGE_PONG_V2';
  const FETCH = 'IU_PAGE_FETCH_V2';
  const RESULT = 'IU_PAGE_FETCH_RESULT_V2';

  function isAllowedUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== IG_ORIGIN) return false;
      const path = parsed.pathname.replace(/\/+$/, '') + '/';
      return (
        /^\/api\/v1\/friendships\/(create|destroy|remove_follower)\/[^/]+\/$/.test(path) ||
        /^\/web\/friendships\/[^/]+\/(follow|unfollow|remove_follower)\/$/.test(path)
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

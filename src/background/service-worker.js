/**
 * Background service worker:
 *  - toolbar badge lifecycle (scanning indicator / unfollower count)
 *  - optional daily sync (off by default, see the popup's settings panel)
 *  - system notifications with the sync results
 *
 * All scanning happens in the content script inside an instagram.com tab; the
 * worker only orchestrates. Transient state lives in chrome.storage.session so
 * it survives MV3 worker suspensions.
 */
const BADGE_COLOR = '#E1306C';
const DAILY_ALARM = 'iu-daily-sync';
const SYNC_MIN_GAP_MS = 20 * 60 * 60 * 1000; // "daily" = at most once per ~20h

function setBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { dailySync: false, notifyResults: true, ...settings };
}

function ensureAlarm() {
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  maybeDailySync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) maybeDailySync();
});

/* ---------- messages ---------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'IU_SCAN_COMPLETE') {
    const count = Number(message.unfollowerCount) || 0;
    setBadge(count === 0 ? '' : count > 999 ? '999+' : String(count));
    onScanComplete(message, sender);
  } else if (message?.type === 'IU_STATE_CHANGED') {
    const status = message.state?.status;
    if (status === 'scanning') {
      setBadge('…');
      chrome.storage.session.set({ scanningTabId: sender?.tab?.id ?? null });
    } else if (status === 'error' || status === 'idle') {
      setBadge('');
      chrome.storage.session.remove('scanningTabId');
      if (status === 'error') onScanError(message.state?.error, sender);
    } else if (status === 'done') {
      chrome.storage.session.remove('scanningTabId');
    }
  } else if (message?.type === 'IU_CONTENT_READY') {
    // A fresh content script in a tab that was mid-scan means the scan died
    // with the old page — clear the stale scanning badge.
    clearIfScanningTab(sender?.tab?.id);
  } else if (message?.type === 'IU_INJECT_PAGE_BRIDGE') {
    const tabId = sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['src/content/page-bridge.js'],
        world: 'MAIN',
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  return false;
});

async function clearIfScanningTab(tabId) {
  if (tabId === undefined || tabId === null) return;
  const { scanningTabId = null } = await chrome.storage.session.get('scanningTabId');
  if (scanningTabId === tabId) {
    setBadge('');
    chrome.storage.session.remove('scanningTabId');
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearIfScanningTab(tabId);
});

/* ---------- notifications ---------- */

function notify(title, messageText) {
  chrome.notifications.create('iu-sync-result', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: messageText,
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs[0]?.id !== undefined) {
    chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId !== undefined) chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: 'https://www.instagram.com/' });
  }
  chrome.notifications.clear('iu-sync-result');
});

async function isPopupOpen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function onScanComplete(message, sender) {
  const { syncTabId = null, syncTabCreated = false } = await chrome.storage.session.get([
    'syncTabId',
    'syncTabCreated',
  ]);
  const fromDailySync = sender?.tab?.id !== undefined && sender.tab.id === syncTabId;
  const settings = await getSettings();

  // Popup shows its own toast; only raise a system notification when nobody
  // is looking at the results (daily sync, or a manual scan finishing with
  // the popup closed).
  if (settings.notifyResults && (fromDailySync || !(await isPopupOpen()))) {
    notify(
      fromDailySync ? 'Instagram daily sync finished' : 'Instagram scan finished',
      (message.summaryLines ?? []).join('\n')
    );
  }

  if (fromDailySync) {
    await chrome.storage.session.remove(['syncTabId', 'syncTabCreated']);
    if (syncTabCreated && syncTabId !== null) {
      chrome.tabs.remove(syncTabId).catch(() => {});
    }
  }
}

async function onScanError(errorMessage, sender) {
  const { syncTabId = null, syncTabCreated = false } = await chrome.storage.session.get([
    'syncTabId',
    'syncTabCreated',
  ]);
  if (sender?.tab?.id === undefined || sender.tab.id !== syncTabId) return;
  await chrome.storage.session.remove(['syncTabId', 'syncTabCreated']);
  const settings = await getSettings();
  if (settings.notifyResults) {
    notify('Instagram daily sync failed', errorMessage || 'Unknown error.');
  }
  if (syncTabCreated && syncTabId !== null) chrome.tabs.remove(syncTabId).catch(() => {});
}

/* ---------- daily sync ---------- */

async function maybeDailySync() {
  const settings = await getSettings();
  if (!settings.dailySync) return;

  const { scans = {}, lastScanUserId = null, lastDailyAttempt = 0 } = await chrome.storage.local.get([
    'scans',
    'lastScanUserId',
    'lastDailyAttempt',
  ]);
  const { syncTabId: activeSync = null } = await chrome.storage.session.get('syncTabId');
  if (activeSync !== null) return; // a sync is already in flight

  const lastScanTs = lastScanUserId !== null ? (scans[lastScanUserId]?.timestamp ?? 0) : 0;
  if (Date.now() - Math.max(lastScanTs, lastDailyAttempt) < SYNC_MIN_GAP_MS) return;
  await chrome.storage.local.set({ lastDailyAttempt: Date.now() });

  // Reuse an open Instagram tab, or open a background one just for the sync.
  let tabId = null;
  let created = false;
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  const usable = tabs.find((t) => !t.discarded);
  if (usable?.id !== undefined) {
    tabId = usable.id;
  } else {
    try {
      const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
      tabId = tab.id ?? null;
      created = true;
    } catch {
      return;
    }
  }
  if (tabId === null) return;
  await chrome.storage.session.set({ syncTabId: tabId, syncTabCreated: created });

  const ready = await waitForContentScript(tabId);
  const res = ready ? await sendMessageSafe(tabId, { type: 'IU_START_SCAN_V5', source: 'daily' }) : null;
  if (!res?.ok) {
    await chrome.storage.session.remove(['syncTabId', 'syncTabCreated']);
    const settings2 = await getSettings();
    if (settings2.notifyResults) {
      notify(
        'Instagram daily sync failed',
        res?.error ?? 'Could not reach Instagram. Make sure you are logged in.'
      );
    }
    if (created) chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function sendMessageSafe(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function waitForContentScript(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let injected = false;
  while (Date.now() < deadline) {
    const res = await sendMessageSafe(tabId, { type: 'IU_GET_STATE_V5' });
    if (res?.ok) return true;
    if (!injected) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['src/content/page-bridge.js'],
            world: 'MAIN',
          });
          await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
          injected = true;
        }
      } catch {
        return false; // tab is gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

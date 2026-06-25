const ALARM_NAME = 'crumbles-cleanup'

const DEFAULT_SETTINGS = {
  retentionDays: 30,
  minVisits: 1,
  schedule: 'hybrid', // 'hybrid' | 'startup' | 'daily' | 'manual'
  scheduleHour: 12, // noon — most likely the machine is on and awake
  dataTypes: {
    history: true,
    cookies: true,
    localStorage: false,
    indexedDB: false,
    cache: false,
  },
  dryRun: false,
  whitelist: [],
}

// --- Storage helpers ---

async function getSettings() {
  const result = await browser.storage.local.get('settings')
  const saved = result.settings || {}
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    dataTypes: { ...DEFAULT_SETTINGS.dataTypes, ...(saved.dataTypes || {}) },
  }
}

async function saveSettings(settings) {
  await browser.storage.local.set({ settings })
}

async function getRunLog() {
  const result = await browser.storage.local.get('runLog')
  return result.runLog || []
}

async function appendRunLog(entry) {
  const log = await getRunLog()
  log.unshift(entry)
  if (log.length > 30) log.splice(30)
  await browser.storage.local.set({ runLog: log })
}

// --- Domain utilities ---

function extractHostname(url) {
  try {
    const { hostname, protocol } = new URL(url)
    if (!['http:', 'https:'].includes(protocol)) return null
    return hostname.toLowerCase()
  } catch {
    return null
  }
}

// Returns true if hostname falls under the given pattern.
// Pattern "example.com" matches "example.com" and "sub.example.com".
function matchesPattern(hostname, pattern) {
  const p = pattern.toLowerCase().trim().replace(/^\./, '')
  const h = hostname.toLowerCase()
  return h === p || h.endsWith('.' + p)
}

function isWhitelisted(hostname, whitelist) {
  return whitelist.some(pattern => matchesPattern(hostname, pattern))
}

// --- History analysis ---

async function getSiteActivity(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000
  const lookback = Date.now() - 365 * 86400000

  const items = await browser.history.search({
    text: '',
    startTime: lookback,
    maxResults: 200000,
  })

  const sites = new Map()

  for (const item of items) {
    const hostname = extractHostname(item.url)
    if (!hostname) continue

    const existing = sites.get(hostname) || { recentVisits: 0, lastVisit: 0 }
    const visitTime = item.lastVisitTime || 0
    if (visitTime > existing.lastVisit) existing.lastVisit = visitTime
    if (visitTime >= cutoff) existing.recentVisits++
    sites.set(hostname, existing)
  }

  return sites
}

// --- Deletion helpers ---

async function deleteHistoryForHostname(hostname) {
  const items = await browser.history.search({
    text: hostname,
    startTime: 0,
    maxResults: 50000,
  })

  let count = 0
  for (const item of items) {
    if (extractHostname(item.url) !== hostname) continue
    await browser.history.deleteUrl({ url: item.url })
    count++
  }
  return count
}

async function deleteCookiesForHostname(hostname) {
  const cookies = await browser.cookies.getAll({ domain: hostname })
  let count = 0
  for (const cookie of cookies) {
    const protocol = cookie.secure ? 'https' : 'http'
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
    try {
      await browser.cookies.remove({
        url: `${protocol}://${domain}${cookie.path || '/'}`,
        name: cookie.name,
        storeId: cookie.storeId,
      })
      count++
    } catch (e) {
      // some cookies may not be removable (e.g. httpOnly in certain contexts)
    }
  }
  return count
}

async function deleteBrowsingDataForOrigins(hostnames, dataTypes) {
  const types = {}
  if (dataTypes.localStorage) types.localStorage = true
  if (dataTypes.indexedDB) types.indexedDB = true
  if (Object.keys(types).length === 0) return

  const origins = hostnames.flatMap(h => [`https://${h}`, `http://${h}`])
  try {
    await browser.browsingData.remove({ origins }, types)
  } catch (e) {
    // origins filter not supported in older Firefox — fall back to time-based
    console.warn('[Crumbles] origin-filtered browsingData removal failed, falling back', e)
    await browser.browsingData.remove({ since: 0 }, types)
  }
}

async function deleteCacheOlderThan(retentionDays) {
  const since = Date.now() - retentionDays * 86400000
  await browser.browsingData.removeCache({ since })
}

// --- Analysis (shared by cleanup + preview) ---

// Reads history and sorts sites into clean/keep buckets. Pure read — no deletion.
async function analyzeSites(settings) {
  const siteActivity = await getSiteActivity(settings.retentionDays)

  const toClean = []
  const toKeep = []

  for (const [hostname, data] of siteActivity) {
    if (isWhitelisted(hostname, settings.whitelist)) {
      toKeep.push({ hostname, reason: 'whitelist' })
      continue
    }
    if (data.recentVisits >= settings.minVisits) {
      toKeep.push({ hostname, reason: 'active' })
      continue
    }
    toClean.push(hostname)
  }

  return {
    sitesAnalyzed: siteActivity.size,
    toClean,
    toKeep,
    keptActive: toKeep.filter(k => k.reason === 'active').length,
    keptWhitelist: toKeep.filter(k => k.reason === 'whitelist').length,
  }
}

// Non-destructive look at what a cleanup would do right now. Drives the popup's
// on-open preview. Never deletes, never writes to the run log.
async function getPreview() {
  const settings = await getSettings()
  const { sitesAnalyzed, toClean, toKeep, keptActive, keptWhitelist } = await analyzeSites(settings)
  return {
    sitesAnalyzed,
    sitesToClean: toClean.length,
    sitesToKeep: toKeep.length,
    keptActive,
    keptWhitelist,
    retentionDays: settings.retentionDays,
    isDryRun: settings.dryRun,
  }
}

// --- Core cleanup engine ---

async function runCleanup(dryRunOverride) {
  const settings = await getSettings()
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : settings.dryRun

  console.log(`[Crumbles] Starting cleanup — retentionDays=${settings.retentionDays} dryRun=${isDryRun}`)

  const { sitesAnalyzed, toClean, toKeep, keptActive, keptWhitelist } = await analyzeSites(settings)

  const stats = {
    timestamp: Date.now(),
    isDryRun,
    sitesAnalyzed,
    sitesKept: toKeep.length,
    keptActive,
    keptWhitelist,
    sitesCleaned: toClean.length,
    historyUrlsDeleted: 0,
    cookiesDeleted: 0,
    dataTypes: { ...settings.dataTypes },
  }

  if (!isDryRun && toClean.length > 0) {
    const needsBrowsingData = settings.dataTypes.localStorage || settings.dataTypes.indexedDB

    for (const hostname of toClean) {
      if (settings.dataTypes.history) {
        stats.historyUrlsDeleted += await deleteHistoryForHostname(hostname)
      }
      if (settings.dataTypes.cookies) {
        stats.cookiesDeleted += await deleteCookiesForHostname(hostname)
      }
    }

    if (needsBrowsingData) {
      await deleteBrowsingDataForOrigins(toClean, settings.dataTypes)
    }

    if (settings.dataTypes.cache) {
      await deleteCacheOlderThan(settings.retentionDays)
    }
  }

  await appendRunLog(stats)

  try {
    browser.runtime.sendMessage({ type: 'cleanupComplete', stats })
  } catch {
    // popup not open
  }

  console.log('[Crumbles] Cleanup complete:', stats)
  return stats
}

// --- Scheduling ---

async function applySchedule(settings) {
  await browser.alarms.clear(ALARM_NAME)

  // Both 'daily' and 'hybrid' use the daily alarm; hybrid layers a startup run on top.
  if (settings.schedule !== 'daily' && settings.schedule !== 'hybrid') return

  const now = new Date()
  const next = new Date()
  next.setHours(settings.scheduleHour, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)

  const delayMinutes = (next.getTime() - now.getTime()) / 60000
  await browser.alarms.create(ALARM_NAME, {
    delayInMinutes: delayMinutes,
    periodInMinutes: 24 * 60,
  })

  console.log(`[Crumbles] Daily cleanup scheduled for ${next.toLocaleString()}`)
}

// --- Listeners ---

browser.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings()
  await applySchedule(settings)
})

browser.runtime.onStartup.addListener(async () => {
  const settings = await getSettings()
  if (settings.schedule === 'startup' || settings.schedule === 'hybrid') {
    await runCleanup()
  }
})

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return
  await runCleanup()
})

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'runNow') {
    runCleanup(message.dryRun)
      .then(stats => sendResponse({ stats }))
      .catch(e => sendResponse({ error: e.message }))
    return true
  }

  if (message.type === 'getPreview') {
    getPreview()
      .then(preview => sendResponse({ preview }))
      .catch(e => sendResponse({ error: e.message }))
    return true
  }

  if (message.type === 'getStatus') {
    Promise.all([getSettings(), getRunLog(), browser.alarms.get(ALARM_NAME)])
      .then(([settings, log, alarm]) => sendResponse({ settings, log, alarm }))
    return true
  }

  if (message.type === 'saveSettings') {
    saveSettings(message.settings)
      .then(() => applySchedule(message.settings))
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }))
    return true
  }

  if (message.type === 'clearLog') {
    browser.storage.local.set({ runLog: [] })
      .then(() => sendResponse({ ok: true }))
    return true
  }
})

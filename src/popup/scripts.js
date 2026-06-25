const runBtn = document.getElementById('runBtn')
const runBtnText = document.getElementById('runBtnText')
const spinner = document.getElementById('spinner')
const runIcon = document.querySelector('.run-icon')
const settingsBtn = document.getElementById('settingsBtn')
const statusLabel = document.getElementById('statusLabel')
const statusSub = document.getElementById('statusSub')
const statusSection = document.getElementById('statusSection')
const statsGroup = document.getElementById('statsGroup')
const statsHeading = document.getElementById('statsHeading')
const dryRunNotice = document.getElementById('dryRunNotice')
const nextRun = document.getElementById('nextRun')
const statusIconClean = document.getElementById('statusIconClean')
const statusIconNever = document.getElementById('statusIconNever')
const statSitesNum = document.getElementById('statSitesNum')
const statHistoryNum = document.getElementById('statHistoryNum')
const statCookiesNum = document.getElementById('statCookiesNum')
const runHint = document.getElementById('runHint')
const statusIconReady = document.getElementById('statusIconReady')

// Cached so the runNow handler (which only receives stats) can build copy that
// depends on the user's settings (retention window, data types).
let currentSettings = null

// A manual run triggers a `cleanupComplete` broadcast from the background; we
// render the result ourselves, so the next auto-refresh should be ignored.
let suppressAutoRefresh = false

function plural(n, word) {
  return `${word}${n === 1 ? '' : 's'}`
}

const DATA_TYPE_LABELS = {
  history: 'history',
  cookies: 'cookies',
  localStorage: 'local storage',
  indexedDB: 'indexed DB',
  cache: 'cache',
}

function describeDataTypes(dataTypes = {}) {
  const labels = Object.keys(DATA_TYPE_LABELS)
    .filter(key => dataTypes[key])
    .map(key => DATA_TYPE_LABELS[key])
  if (labels.length === 0) return 'data'
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

function buildRuleHint(settings) {
  if (!settings) return ''
  const types = describeDataTypes(settings.dataTypes)
  return `Removes ${types} for sites untouched ${settings.retentionDays}+ days`
}

// One sentence explaining *why* the kept sites were spared. Shared by the
// forward-looking preview and the post-run result so the wording stays in sync.
function keptReasonSentence(kept, keptActive, keptWhitelist, retentionDays) {
  const sites = plural(kept, 'site')
  if (keptWhitelist > 0 && keptActive === 0) {
    return `All ${kept} ${sites} are on your keep-list.`
  }
  if (keptWhitelist > 0 && keptActive > 0) {
    return `Your ${kept} ${sites} are recently used or on your keep-list.`
  }
  if (retentionDays != null) {
    return `All ${kept} ${sites} were visited in the last ${retentionDays} days.`
  }
  return `All ${kept} ${sites} were visited recently.`
}

// Forward-looking: what a cleanup would do if you clicked Run right now.
function describePreview(preview) {
  const { sitesAnalyzed, sitesToClean, sitesToKeep, retentionDays } = preview

  if (sitesAnalyzed === 0) {
    return { label: 'Nothing to clean', sub: 'No site data to review yet.', state: 'clean' }
  }

  if (sitesToClean > 0) {
    const cleanWord = plural(sitesToClean, 'site')
    const line2 = sitesToKeep > 0
      ? `${sitesToKeep} ${plural(sitesToKeep, 'site')} will be kept.`
      : 'Click Run Cleanup to remove them.'
    return {
      label: 'Ready to clean',
      sub: `${sitesToClean} stale ${cleanWord} can be cleared now.\n${line2}`,
      state: 'ready',
    }
  }

  const reason = keptReasonSentence(sitesToKeep, preview.keptActive, preview.keptWhitelist, retentionDays)
  return { label: 'Nothing to clean', sub: `${reason}\nNothing stale right now.`, state: 'clean' }
}

// Backward-looking: the outcome of a run that just happened.
function describeOutcome(entry, settings, relTime) {
  const retentionDays = settings ? settings.retentionDays : null
  const kept = entry.sitesKept
  const cleaned = entry.sitesCleaned

  if (entry.isDryRun) {
    let sub = `Would remove ${cleaned} stale ${plural(cleaned, 'site')}.`
    if (kept > 0) sub += `\n${kept} ${plural(kept, 'site')} would be kept.`
    return { label: `Preview · ${relTime}`, sub }
  }

  if (entry.sitesAnalyzed === 0) {
    return { label: 'All clean', sub: 'No site data to review yet.' }
  }

  if (cleaned > 0) {
    let sub = `${cleaned} stale ${plural(cleaned, 'site')} cleared.`
    if (kept > 0) sub += `\n${kept} ${plural(kept, 'site')} kept.`
    return { label: `Cleaned · ${relTime}`, sub }
  }

  const reason = keptReasonSentence(kept, entry.keptActive, entry.keptWhitelist, retentionDays)
  return { label: `All clean · ${relTime}`, sub: `${reason}\nNothing stale to remove.` }
}

// Status-section icon: 'ready' (action available), 'clean' (all tidy),
// 'loading' (no icon while the preview is being fetched).
function setStatusIcon(state) {
  statusIconReady.classList.toggle('visible', state === 'ready')
  statusIconClean.classList.toggle('visible', state === 'clean')
  statusIconNever.classList.toggle('visible', state === 'never')
}

function flashStatus() {
  statusSection.classList.remove('flash')
  void statusSection.offsetWidth
  statusSection.classList.add('flash')
}

function formatRelativeTime(ts) {
  if (!ts) return null
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function formatAlarmTime(alarm) {
  if (!alarm) return null
  const d = new Date(alarm.scheduledTime)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const isTomorrow = d.toDateString() === new Date(now.getTime() + 86400000).toDateString()
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (isToday) return `Next run today at ${timeStr}`
  if (isTomorrow) return `Next run tomorrow at ${timeStr}`
  return `Next run ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`
}

// Historical "Last cleanup" card — what the previous run actually removed.
function renderHistory(lastEntry) {
  if (!lastEntry) {
    statsGroup.style.display = 'none'
    return
  }
  const relTime = formatRelativeTime(lastEntry.timestamp)
  statsHeading.textContent = lastEntry.isDryRun ? `Last preview · ${relTime}` : `Last cleanup · ${relTime}`
  statSitesNum.textContent = lastEntry.sitesCleaned
  statHistoryNum.textContent = lastEntry.historyUrlsDeleted
  statCookiesNum.textContent = lastEntry.cookiesDeleted
  statsGroup.style.display = 'flex'
}

function renderSchedule(schedule, alarm) {
  if (schedule === 'startup') {
    nextRun.textContent = 'Runs on browser startup'
    return
  }
  if (schedule === 'manual') {
    nextRun.textContent = 'Manual mode. Click to clean anytime.'
    return
  }
  if (schedule === 'hybrid') {
    nextRun.textContent = 'Runs on startup and daily'
    return
  }
  // daily — show the next scheduled run time from the alarm
  nextRun.textContent = ''
  if (alarm) {
    const alarmText = formatAlarmTime(alarm)
    if (alarmText) nextRun.textContent = alarmText
  }
}

function setRunning(running) {
  runBtn.disabled = running
  spinner.style.display = running ? 'block' : 'none'
  runIcon.style.display = running ? 'none' : 'block'
  runBtnText.textContent = running ? 'Cleaning…' : 'Run Cleanup'
}

// Settings, schedule, and the historical card. Cheap — no history scan.
function loadStatus() {
  browser.runtime.sendMessage({ type: 'getStatus' }, ({ settings, log, alarm }) => {
    currentSettings = settings
    runHint.textContent = buildRuleHint(settings)
    dryRunNotice.style.display = settings.dryRun ? 'flex' : 'none'
    renderHistory(log && log[0])
    renderSchedule(settings.schedule, alarm)
  })
}

// Forward-looking preview in the status section. Scans history, so it runs
// separately and shows a brief loading state. Falls back gracefully if the
// background can't answer, so it never hangs on the loading message.
function loadPreview() {
  statusLabel.textContent = 'Checking your sites…'
  statusSub.textContent = ''
  setStatusIcon('loading')

  let settled = false
  const fallback = () => {
    if (settled) return
    settled = true
    statusLabel.textContent = 'Ready to clean'
    statusSub.textContent = 'Click Run Cleanup to tidy up stale sites.'
    setStatusIcon('ready')
  }
  const timer = setTimeout(fallback, 4000)

  browser.runtime.sendMessage({ type: 'getPreview' }, response => {
    clearTimeout(timer)
    if (settled) return
    if (browser.runtime.lastError || !response || !response.preview) {
      fallback()
      return
    }
    settled = true
    const { label, sub, state } = describePreview(response.preview)
    statusLabel.textContent = label
    statusSub.textContent = sub
    setStatusIcon(state)
  })
}

function refresh() {
  loadStatus()
  loadPreview()
}

runBtn.addEventListener('click', () => {
  setRunning(true)
  suppressAutoRefresh = true

  browser.runtime.sendMessage({ type: 'runNow' }, response => {
    setRunning(false)
    if (response && response.stats) {
      const s = response.stats
      const { label, sub } = describeOutcome(s, currentSettings, 'just now')
      statusLabel.textContent = label
      statusSub.textContent = sub
      setStatusIcon('clean')
      flashStatus()
      renderHistory(s)
    }
  })
})

settingsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage()
})

browser.runtime.onMessage.addListener(message => {
  if (message.type === 'cleanupComplete') {
    // A manual run already painted its own result; only refresh for background runs.
    if (suppressAutoRefresh) {
      suppressAutoRefresh = false
      return
    }
    refresh()
  }
})

refresh()

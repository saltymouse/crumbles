// --- State ---
let settings = null
let saveTimer = null

// --- DOM refs ---
const scheduleHourSelect = document.getElementById('scheduleHour')
const timePicker = document.getElementById('timePicker')
const retentionDaysInput = document.getElementById('retentionDays')
const minVisitsInput = document.getElementById('minVisits')
const dtHistory = document.getElementById('dtHistory')
const dtCookies = document.getElementById('dtCookies')
const dtLocalStorage = document.getElementById('dtLocalStorage')
const dtIndexedDB = document.getElementById('dtIndexedDB')
const dtCache = document.getElementById('dtCache')
const dryRunToggle = document.getElementById('dryRun')
const whitelistInput = document.getElementById('whitelistInput')
const whitelistAddBtn = document.getElementById('whitelistAddBtn')
const whitelistItems = document.getElementById('whitelistItems')
const whitelistEmpty = document.getElementById('whitelistEmpty')
const logList = document.getElementById('logList')
const logEmpty = document.getElementById('logEmpty')
const clearLogBtn = document.getElementById('clearLogBtn')
const saveStatus = document.getElementById('saveStatus')

// --- Hour options ---
// Formats an hour-of-day using the user's locale, so it follows their system's
// 12h/24h preference (e.g. "2:00 PM" in en-US, "14:00" in ja-JP).
function formatHour(h) {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function buildHourOptions() {
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option')
    opt.value = h
    opt.textContent = formatHour(h)
    scheduleHourSelect.appendChild(opt)
  }
}

// --- Load settings into form ---
function applySettingsToForm(s) {
  // Schedule
  const radioVal = document.querySelector(`input[name="schedule"][value="${s.schedule}"]`)
  if (radioVal) radioVal.checked = true
  updateTimePicker()

  scheduleHourSelect.value = s.scheduleHour

  // Retention
  retentionDaysInput.value = s.retentionDays
  minVisitsInput.value = s.minVisits

  // Data types
  dtHistory.checked = s.dataTypes.history
  dtCookies.checked = s.dataTypes.cookies
  dtLocalStorage.checked = s.dataTypes.localStorage
  dtIndexedDB.checked = s.dataTypes.indexedDB
  dtCache.checked = s.dataTypes.cache

  // Dry run
  dryRunToggle.checked = s.dryRun

  // Whitelist
  renderWhitelist(s.whitelist)
}

// --- Read settings from form ---
function readSettingsFromForm() {
  const scheduleRadio = document.querySelector('input[name="schedule"]:checked')
  return {
    schedule: scheduleRadio ? scheduleRadio.value : 'hybrid',
    scheduleHour: parseInt(scheduleHourSelect.value, 10),
    retentionDays: Math.max(1, Math.min(365, parseInt(retentionDaysInput.value, 10) || 30)),
    minVisits: Math.max(1, Math.min(50, parseInt(minVisitsInput.value, 10) || 1)),
    dataTypes: {
      history: dtHistory.checked,
      cookies: dtCookies.checked,
      localStorage: dtLocalStorage.checked,
      indexedDB: dtIndexedDB.checked,
      cache: dtCache.checked,
    },
    dryRun: dryRunToggle.checked,
    whitelist: settings ? [...settings.whitelist] : [],
  }
}

// --- Show/hide time picker based on schedule selection ---
function updateTimePicker() {
  // The daily timer is used by both the "daily" and "hybrid" schedules.
  const usesTimer =
    document.getElementById('scheduleDaily').checked ||
    document.getElementById('scheduleHybrid').checked
  timePicker.classList.toggle('visible', usesTimer)
}

// --- Save (debounced) ---
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persistSettings, 400)
}

function persistSettings() {
  const updated = readSettingsFromForm()
  settings = updated
  browser.runtime.sendMessage({ type: 'saveSettings', settings: updated }, response => {
    if (response && response.ok) {
      showSaveStatus('Saved')
    }
  })
}

let saveStatusTimer = null
function showSaveStatus(text) {
  saveStatus.textContent = text
  saveStatus.classList.add('visible')
  clearTimeout(saveStatusTimer)
  saveStatusTimer = setTimeout(() => saveStatus.classList.remove('visible'), 1800)
}

// --- Whitelist ---
function renderWhitelist(list) {
  whitelistItems.replaceChildren()
  if (!list || list.length === 0) {
    whitelistEmpty.style.display = 'block'
    return
  }
  whitelistEmpty.style.display = 'none'
  for (const domain of list) {
    const li = document.createElement('li')
    li.className = 'whitelist-item'
    li.dataset.domain = domain

    const name = document.createElement('span')
    name.className = 'whitelist-domain'
    name.textContent = domain

    const remove = document.createElement('button')
    remove.className = 'whitelist-remove'
    remove.title = `Remove ${domain}`
    remove.setAttribute('aria-label', `Remove ${domain}`)
    remove.textContent = '✕'
    remove.addEventListener('click', () => removeWhitelistDomain(domain))

    li.append(name, remove)
    whitelistItems.appendChild(li)
  }
}

function addWhitelistDomain() {
  const raw = whitelistInput.value.trim().toLowerCase()
  if (!raw) return

  // Strip protocol if accidentally pasted
  const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!domain || domain.includes(' ')) {
    whitelistInput.style.borderColor = '#ef4444'
    setTimeout(() => (whitelistInput.style.borderColor = ''), 1200)
    return
  }

  if (!settings.whitelist.includes(domain)) {
    settings.whitelist.push(domain)
    renderWhitelist(settings.whitelist)
    persistSettings()
  }

  whitelistInput.value = ''
  whitelistInput.focus()
}

function removeWhitelistDomain(domain) {
  settings.whitelist = settings.whitelist.filter(d => d !== domain)
  renderWhitelist(settings.whitelist)
  persistSettings()
}

// --- Activity Log ---
function formatDate(ts) {
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  if (mins < 1) return 'Just now'
  if (hours < 1) return `${mins}m ago`
  if (days < 1) return `Today at ${timeStr}`
  if (days === 1) return `Yesterday at ${timeStr}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${timeStr}`
}

function renderLog(log) {
  logList.replaceChildren()
  if (!log || log.length === 0) {
    logEmpty.style.display = 'block'
    return
  }
  logEmpty.style.display = 'none'

  for (const entry of log) {
    let badgeClass, badgeLabel
    if (entry.isDryRun) {
      badgeClass = 'log-badge--preview'
      badgeLabel = 'Preview'
    } else if (entry.sitesCleaned > 0) {
      badgeClass = 'log-badge--cleaned'
      badgeLabel = 'Cleaned'
    } else {
      badgeClass = 'log-badge--nothing'
      badgeLabel = 'Nothing to clean'
    }

    let summaryText, detailText
    if (entry.isDryRun) {
      summaryText = `Would clean ${entry.sitesCleaned} site${entry.sitesCleaned !== 1 ? 's' : ''}`
      detailText = `${entry.sitesAnalyzed} sites analyzed, ${entry.sitesKept} kept`
    } else if (entry.sitesCleaned > 0) {
      summaryText = `${entry.sitesCleaned} site${entry.sitesCleaned !== 1 ? 's' : ''} cleaned`
      const parts = []
      if (entry.historyUrlsDeleted > 0) parts.push(`${entry.historyUrlsDeleted} history items`)
      if (entry.cookiesDeleted > 0) parts.push(`${entry.cookiesDeleted} cookies`)
      detailText = parts.length ? parts.join(', ') + ' removed' : `${entry.sitesKept} sites kept`
    } else {
      summaryText = 'Nothing to clean'
      detailText = `${entry.sitesAnalyzed} sites, all active or protected`
    }

    const div = document.createElement('div')
    div.className = 'log-entry'

    const left = document.createElement('div')
    left.className = 'log-left'

    const time = document.createElement('div')
    time.className = 'log-time'
    time.textContent = formatDate(entry.timestamp)

    const summary = document.createElement('div')
    summary.className = 'log-summary'
    summary.textContent = summaryText

    const detail = document.createElement('div')
    detail.className = 'log-detail'
    detail.textContent = detailText

    left.append(time, summary, detail)

    const badge = document.createElement('span')
    badge.className = `log-badge ${badgeClass}`
    badge.textContent = badgeLabel

    div.append(left, badge)
    logList.appendChild(div)
  }
}

// --- Browser detection ---
async function getBrowserName() {
  // Gecko-based (Firefox, Waterfox, etc.) — only these expose getBrowserInfo
  if (browser.runtime.getBrowserInfo) {
    try {
      const { name } = await browser.runtime.getBrowserInfo()
      return name
    } catch {}
  }

  // Chromium-based — filter out noise entries like "Not)A;Brand" and "Chromium"
  // to surface the real product name (Brave, Vivaldi, Edge, Opera, Chrome, etc.)
  if (navigator.userAgentData?.brands) {
    const real = navigator.userAgentData.brands
      .map(b => b.brand)
      .filter(b => !/not/i.test(b) && b !== 'Chromium')
    if (real.length) return real[0]
    // Plain Chromium has no additional brand
    if (navigator.userAgentData.brands.some(b => b.brand === 'Chromium')) return 'Chromium'
  }

  return 'the browser'
}

// --- Event wiring ---
function wireEvents() {
  // Schedule radios
  document.querySelectorAll('input[name="schedule"]').forEach(radio => {
    radio.addEventListener('change', () => {
      updateTimePicker()
      scheduleSave()
    })
  })

  scheduleHourSelect.addEventListener('change', scheduleSave)
  retentionDaysInput.addEventListener('input', scheduleSave)
  minVisitsInput.addEventListener('input', scheduleSave)

  dtHistory.addEventListener('change', scheduleSave)
  dtCookies.addEventListener('change', scheduleSave)
  dtLocalStorage.addEventListener('change', scheduleSave)
  dtIndexedDB.addEventListener('change', scheduleSave)
  dtCache.addEventListener('change', scheduleSave)
  dryRunToggle.addEventListener('change', scheduleSave)

  whitelistAddBtn.addEventListener('click', addWhitelistDomain)
  whitelistInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') addWhitelistDomain()
  })

  clearLogBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'clearLog' }, () => {
      renderLog([])
      showSaveStatus('Log cleared')
    })
  })
}

// --- Init ---
async function init() {
  buildHourOptions()
  wireEvents()

  // Swap browser name into schedule descriptions as soon as we know it
  getBrowserName().then(name => {
    document.getElementById('descHybrid').textContent =
      `Runs when ${name} opens and once a day. Best coverage — catches launches, long sessions, and time missed while your computer was asleep.`
    document.getElementById('descStartup').textContent =
      `Runs once each time ${name} opens. Reliable and unobtrusive.`
    document.getElementById('descDaily').textContent =
      `Runs once per day while ${name} is open.`
  })

  browser.runtime.sendMessage({ type: 'getStatus' }, ({ settings: s, log }) => {
    settings = s
    applySettingsToForm(s)
    renderLog(log)
  })
}

init()

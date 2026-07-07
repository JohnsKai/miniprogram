/**
 * 会话本地存储 + 远端同步（远端不可用时降级本地）
 */

const api = require('./api')
const sessionMessages = require('./session-messages')
const logger = require('./logger')

const STORAGE_KEY = 'session_store_v1'
const MAX_OPEN_TABS = 5
const MAX_SESSIONS_HINT = '最多规划5个行程'

const STATUS_LABEL = {
  created: '待开始',
  planning: '规划中',
  waiting_answer: '待回答',
  done: '已完成',
  interrupted: '已中断'
}

function defaultChatState() {
  return {
    messages: [],
    scrollTo: '',
    streamingBuffer: '',
    inputValue: '',
    inputFocus: false,
    inputPlaceholder: '输入消息...',
    awaitingReply: false,
    planComplete: false,
    postPlanChat: false,
    isThinking: false,
    traceId: '',
    summary: '',
    days: [],
    showOverlay: false,
    showInterruptBanner: false
  }
}

function defaultSession(payload) {
  const app = getApp()
  const destination = payload.destination || ''
  const days = payload.days || 1
  const query = payload.query || `${destination}${days}天`
  const sessionId = payload.sessionId || ('sess_local_' + Date.now())
  const userId = payload.userId || (app && app.getUserId && app.getUserId()) || ('wx_' + Date.now())
  return {
    sessionId,
    title: payload.title || query,
    query,
    destination,
    days,
    preferences: payload.preferences || {},
    status: payload.status || 'created',
    traceId: payload.traceId || '',
    userId,
    summaryPreview: payload.summaryPreview || '',
    pinned: false,
    planResult: payload.planResult || null,
    chat: defaultChatState(),
    updatedAt: Date.now(),
    local: !!payload.local
  }
}

function hasPlanContent(messages) {
  return (messages || []).some((m) => {
    if (m.type === 'day' && m.dayData) return true
    if (m.type === 'summary' && m.summary) return true
    if (m.type === 'route' && m.days && m.days.length) return true
    return false
  })
}

function hasEmptyPlanShell(messages) {
  return (messages || []).some((m) => {
    const text = m.content || ''
    return String(text).indexOf('暂未解析到详细内容') >= 0
      || String(text).indexOf('行程还在生成中') >= 0
  })
}

const normalizeUiMessages = sessionMessages.normalizeUiMessages
const contentKey = sessionMessages.contentKey
const isPlanMessage = sessionMessages.isPlanMessage

function messageKey(m) {
  if (!m) return ''
  const ck = contentKey(m)
  if (ck && ck.indexOf('id:') !== 0) return 'c:' + ck
  if (m.id) return 'id:' + m.id
  return [m.role, m.type, m.content || '', m.summary || ''].join('\0')
}

function mergeDialogPreserveOrder(primary, secondary) {
  const seen = new Set()
  const out = []
  ;(primary || []).concat(secondary || []).forEach((m) => {
    const key = messageKey(m)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(m)
  })
  return out
}

function pickPlanBlock(server, local) {
  const serverPlan = (server || []).filter(isPlanMessage)
  const localPlan = (local || []).filter(isPlanMessage)
  if (!serverPlan.length) return localPlan
  if (!localPlan.length) return serverPlan
  return countPlanUnits(serverPlan) >= countPlanUnits(localPlan) ? serverPlan : localPlan
}

/** 按 message.id 去重合并；prepend 时将 incoming 插入头部（上拉加载更早） */
function mergeMessagesById(existing, incoming, options) {
  const prepend = !!(options && options.prepend)
  const seen = new Set((existing || []).map((m) => m.id).filter(Boolean))
  const base = [...(existing || [])]
  const toAdd = []
  for (const m of incoming || []) {
    if (!m.id || seen.has(m.id)) continue
    seen.add(m.id)
    toAdd.push(m)
  }
  return prepend ? toAdd.concat(base) : base.concat(toAdd)
}

function appendLocalDialogTail(serverDialog, localNorm) {
  const serverKeys = new Set(serverDialog.map((m) => contentKey(m)).filter(Boolean))
  const localDialog = sessionMessages.stripPlanBlocks(localNorm || [])
    .filter((m) => !sessionMessages.isLocalIntakeNoise(m))
  const tail = localDialog.filter((m) => {
    const k = contentKey(m)
    return !k || !serverKeys.has(k)
  })
  if (!tail.length) return serverDialog
  return mergeDialogPreserveOrder(serverDialog, tail)
}

/** 合并本地与服务端消息：按 role+content 去重（本地 msg_N 与服务端 msg_xxx 不重复追加）。 */
function mergeChatTimeline(local, server) {
  const localNorm = normalizeUiMessages(local || [])
  const serverNorm = normalizeUiMessages(server || [])
  if (!serverNorm.length) return localNorm
  const serverMissingAssistant = sessionMessages.serverMissingAssistantDialog(serverNorm)
  const legacyCollapse = serverMissingAssistant
  const serverDialog = sessionMessages.prepareIntakeDialog(serverNorm, { legacyCollapse })
  if (!localNorm.length) return serverDialog

  const localStats = sessionMessages.countDialogStats(localNorm)
  const serverStats = sessionMessages.countDialogStats(serverNorm)
  if (serverMissingAssistant && localStats.assistantText > serverStats.assistantText) {
    const localDialog = sessionMessages.stripPlanBlocks(localNorm)
      .filter((m) => !sessionMessages.isLocalIntakeNoise(m))
    const serverPlan = (serverNorm || []).filter(isPlanMessage)
    const plan = serverPlan.length ? pickPlanBlock(serverNorm, localNorm) : []
    return mergeDialogPreserveOrder(localDialog, plan)
  }

  if (!serverMissingAssistant) {
    const merged = appendLocalDialogTail(serverDialog, localNorm)
    const serverPlan = (serverNorm || []).filter(isPlanMessage)
    const localPlan = (localNorm || []).filter(isPlanMessage)
    if (serverPlan.length || localPlan.length) {
      const plan = pickPlanBlock(serverNorm, localNorm)
      const dialog = sessionMessages.stripPlanBlocks(merged)
      return mergeDialogPreserveOrder(dialog, plan)
    }
    return merged
  }

  if (hasPlanContent(localNorm) && localNorm.length >= serverNorm.length) {
    if (hasPlanContent(serverNorm)) {
      return localNorm
    }
    return sessionMessages.stripPlanBlocks(localNorm)
  }

  const localKeys = new Set(localNorm.map(contentKey).filter(Boolean))
  const serverAllInLocal = serverNorm.every((m) => {
    const k = contentKey(m)
    return !k || localKeys.has(k)
  })
  if (serverAllInLocal && localNorm.length >= serverNorm.length) {
    return localNorm
  }

  const hasServerQuestions = serverDialog.some(
    (m) => m.role === 'assistant' && m.type === 'text'
  )
  if (hasServerQuestions) {
    return appendLocalDialogTail(serverDialog, localNorm)
  }

  const seen = new Set()
  const out = []
  const push = (m) => {
    const k = contentKey(m) || (m.id ? 'id:' + m.id : messageKey(m))
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push(m)
  }
  serverNorm.forEach(push)
  localNorm.forEach((m) => {
    if (m.type === 'thinking' || m.type === 'phase') return
    if (sessionMessages.isPlanIntroMessage && sessionMessages.isPlanIntroMessage(m)) return
    push(m)
  })
  return sessionMessages.prepareIntakeDialog(out, { legacyCollapse: false })
}

/** 合并服务端与本地消息：保留完整时间线，服务端为主并追加本地未同步尾部 */
function pickMessages(serverMsgs, cachedMsgs) {
  const server = normalizeUiMessages(serverMsgs)
  const local = normalizeUiMessages(cachedMsgs || [])
  if (!server.length) return local
  if (!local.length) return server

  if (local.length > server.length) {
    return server.concat(local.slice(server.length))
  }
  return server
}

function countPlanUnits(messages) {
  return (messages || []).filter((m) =>
    m.type === 'day' || (m.type === 'summary' && m.summary)
  ).length
}

function loadStore() {
  const raw = wx.getStorageSync(STORAGE_KEY)
  if (raw && raw.sessions) return raw
  return { openTabs: [], activeSessionId: '', sessions: {}, historyIds: [] }
}

function saveStore(store) {
  wx.setStorageSync(STORAGE_KEY, store)
}

function formatRelativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前'
  return Math.floor(diff / 86400000) + '天前'
}

function toSidebarItem(session) {
  return {
    sessionId: session.sessionId,
    title: session.title,
    destination: session.destination,
    status: session.status,
    statusLabel: STATUS_LABEL[session.status] || session.status,
    summaryPreview: session.summaryPreview || '',
    pinned: !!session.pinned,
    updatedAt: session.updatedAt,
    timeLabel: formatRelativeTime(session.updatedAt)
  }
}

function getOpenTabs(store) {
  return (store.openTabs || [])
    .map((id) => store.sessions[id])
    .filter(Boolean)
    .map((s) => ({ sessionId: s.sessionId, title: s.title, status: s.status }))
}

function getHistoryList(store) {
  const ids = store.historyIds || Object.keys(store.sessions)
  return ids
    .map((id) => store.sessions[id])
    .filter(Boolean)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
    .map(toSidebarItem)
}

function upsertSession(session) {
  const store = loadStore()
  store.sessions[session.sessionId] = session
  if ((store.historyIds || []).indexOf(session.sessionId) < 0) {
    store.historyIds = [session.sessionId].concat(store.historyIds || [])
  }
  saveStore(store)
  return session
}

function touchSession(sessionId, patch) {
  const store = loadStore()
  const session = store.sessions[sessionId]
  if (!session) return null
  if (patch && patch.preferences && session.preferences) {
    patch = {
      ...patch,
      preferences: { ...session.preferences, ...patch.preferences }
    }
  }
  Object.assign(session, patch, { updatedAt: Date.now() })
  saveStore(store)
  return session
}

function saveChatState(sessionId, chat, extra) {
  return touchSession(sessionId, {
    chat: { ...chat },
    ...(extra || {})
  })
}

async function createSession(payload) {
  try {
    await api.ensureLogin()
    const res = await api.createSession(payload)
    const preferences = payload.preferences || {}
    const session = defaultSession({
      ...payload,
      sessionId: res.sessionId,
      title: res.title || payload.query,
      status: res.status || 'created',
      preferences,
      local: false
    })
    const store = loadStore()
    pruneOrphanLocalSessions(store, {
      serverSessionId: session.sessionId,
      query: session.query,
      destination: session.destination,
      days: session.days
    })
    saveStore(store)
    return upsertSession(session)
  } catch (e) {
    const session = defaultSession({ ...payload, local: true })
    return upsertSession(session)
  }
}

function sessionDedupeKey(session) {
  if (!session) return ''
  const q = String(session.query || session.title || '').trim().toLowerCase()
  const dest = String(session.destination || '').trim().toLowerCase()
  const days = parseInt(session.days, 10) || 0
  return [dest || q, days].join('|')
}

/** 服务端已有同 query 规划时，移除残留的 sess_local_*，避免「我的」重复一条 */
function pruneOrphanLocalSessions(store, options) {
  options = options || {}
  const serverKeys = new Set()
  Object.values(store.sessions || {}).forEach((s) => {
    if (!s || s.local || String(s.sessionId || '').startsWith('sess_local_')) return
    const k = sessionDedupeKey(s)
    if (k) serverKeys.add(k)
  })
  if (options.query && options.serverSessionId) {
    serverKeys.add(sessionDedupeKey({ query: options.query, destination: options.destination, days: options.days }))
  }
  if (!serverKeys.size) return
  Object.keys(store.sessions || {}).forEach((id) => {
    const s = store.sessions[id]
    if (!s || !s.local || !String(id).startsWith('sess_local_')) return
    if (options.serverSessionId && id === options.serverSessionId) return
    const k = sessionDedupeKey(s)
    if (k && serverKeys.has(k)) {
      delete store.sessions[id]
      store.historyIds = (store.historyIds || []).filter((hid) => hid !== id)
      store.openTabs = (store.openTabs || []).filter((hid) => hid !== id)
      if (store.activeSessionId === id) {
        store.activeSessionId = store.openTabs[store.openTabs.length - 1] || ''
      }
    }
  })
}

function reconcileHistoryIds(store, serverItems) {
  pruneOrphanLocalSessions(store)
  const serverIds = (serverItems || []).map((item) => item.sessionId).filter(Boolean)
  const seen = new Set()
  const next = []

  serverIds.forEach((id) => {
    if (!store.sessions[id] || seen.has(id)) return
    seen.add(id)
    next.push(id)
  })

  ;(store.historyIds || []).forEach((id) => {
    const session = store.sessions[id]
    if (!session || seen.has(id)) return
    if (session.local && String(id).startsWith('sess_local_')) {
      const k = sessionDedupeKey(session)
      const dupServer = serverIds.some((sid) => {
        const remote = store.sessions[sid]
        return remote && !remote.local && sessionDedupeKey(remote) === k
      })
      if (dupServer) return
    }
    seen.add(id)
    next.push(id)
  })

  store.historyIds = next
}

async function fetchHistory(keyword) {
  try {
    await api.ensureLogin()
    const res = await api.listSessions({ page: 1, pageSize: 50, keyword: keyword || '' })
    const items = res.items || []
    const store = loadStore()
    items.forEach((item) => {
      const existing = store.sessions[item.sessionId]
      const updatedAt = item.updatedAtMs || item.updatedAt || (existing && existing.updatedAt) || Date.now()
      store.sessions[item.sessionId] = {
        ...(existing || defaultSession(item)),
        ...item,
        chat: (existing && existing.chat) ? existing.chat : defaultChatState(),
        planResult: (existing && existing.planResult) || item.planResult || null,
        updatedAt,
        local: false
      }
    })
    if (!keyword) {
      reconcileHistoryIds(store, items)
    } else {
      items.forEach((item) => {
        if ((store.historyIds || []).indexOf(item.sessionId) < 0) {
          store.historyIds.push(item.sessionId)
        }
      })
    }
    saveStore(store)
    return getHistoryList(store)
  } catch (e) {
    return getHistoryList(loadStore())
  }
}

async function loadSessionDetail(sessionId) {
  const store = loadStore()
  const cached = store.sessions[sessionId]
  try {
    await api.ensureLogin()
    const detail = await api.getSession(sessionId)
    let serverMessages = []
    let msgPagination = { page: 0, size: 50, total: 0, hasMore: false }
    try {
      const msgRes = await api.getSessionMessages(sessionId, { format: 'ui', page: 0, size: 50 })
      serverMessages = (msgRes && msgRes.messages) || []
      msgPagination = {
        page: msgRes.page != null ? msgRes.page : 0,
        size: msgRes.size != null ? msgRes.size : 50,
        total: msgRes.total != null ? msgRes.total : serverMessages.length,
        hasMore: !!msgRes.hasMore,
        nextCursor: (msgRes && msgRes.nextCursor) || null
      }
    } catch (e) {
      logger.log('session-messages', `[${sessionId}] WARN GET /messages 失败，不使用本地消息缓存`)
    }

    logger.log('session-messages', `[${sessionId}] 原始 server=${serverMessages.length}`)
    logger.log('session-messages', `[${sessionId}] server ${JSON.stringify(sessionMessages.summarizeMessages(serverMessages, 'server'))}`)
    if (sessionMessages.serverMissingAssistantDialog(serverMessages)) {
      logger.log(
        'session-messages',
        `[${sessionId}] WARN 服务端未返回完整 Agent 对话（user 多于 assistant），intake 提问需后端持久化`
      )
    }

    const session = {
      ...(cached || defaultSession(detail)),
      ...detail,
      updatedAt: detail.updatedAtMs || detail.updatedAt || (cached && cached.updatedAt) || Date.now(),
      chat: defaultChatState(),
      local: false,
      msgPagination
    }
    if (detail.recovery) {
      session.recovery = detail.recovery
      if (detail.recovery.planSteps) {
        session.planSteps = detail.recovery.planSteps
      }
      if (detail.recovery.intakeProgress && !detail.intakeProgress) {
        detail.intakeProgress = detail.recovery.intakeProgress
      }
    }
    if (detail.intakeProgress) {
      session.intakeProgress = detail.intakeProgress
    }
    if (detail.planningPhase) {
      session.planningPhase = detail.planningPhase
    }
    if (detail.degraded != null) {
      session.degraded = !!detail.degraded
    }
    if (detail.preferences) {
      session.preferences = {
        ...((cached && cached.preferences) || {}),
        ...detail.preferences
      }
    }
    const planResult = detail.planResult || null
    session.chat.messages = sessionMessages.normalizeSessionMessages(serverMessages, planResult)
    logger.log('session-messages', `[${sessionId}] normalized ${JSON.stringify(sessionMessages.summarizeMessages(session.chat.messages, 'normalized'))}`)
    if (detail.planResult) {
      session.planResult = detail.planResult
      session.chat.summary = detail.planResult.summary || session.chat.summary || ''
      session.chat.days = detail.planResult.days || session.chat.days || []
      session.chat.planComplete = true
      session.chat.postPlanChat = true
    }
    if (!detail.planResult && detail.status !== 'done' && hasPlanContent(session.chat.messages)) {
      session.chat.messages = sessionMessages.stripPlanBlocks(session.chat.messages)
      session.chat.planComplete = false
      session.chat.postPlanChat = false
      session.planResult = null
    }
    const recoveryTraceId = detail.traceId
      || (detail.recovery && detail.recovery.lastTraceId)
      || ''
    if (recoveryTraceId) {
      session.traceId = recoveryTraceId
      session.chat.traceId = recoveryTraceId
    }
    upsertSession(session)
    return session
  } catch (e) {
    logger.log('session-messages', `[${sessionId}] loadSessionDetail 失败，不回退本地消息`)
    return null
  }
}

function countSessions(store) {
  const s = store || loadStore()
  return Object.keys(s.sessions || {}).length
}

function canCreateSession(store) {
  return countSessions(store) < MAX_OPEN_TABS
}

function addOpenTab(sessionId) {
  const store = loadStore()
  if (!store.sessions[sessionId]) return { ok: false, reason: 'not_found' }
  if (store.openTabs.indexOf(sessionId) < 0) {
    if (store.openTabs.length >= MAX_OPEN_TABS) {
      return { ok: false, reason: 'max_tabs', max: MAX_OPEN_TABS }
    }
    store.openTabs.push(sessionId)
  }
  store.activeSessionId = sessionId
  saveStore(store)
  return { ok: true, store }
}

function removeOpenTab(sessionId) {
  const store = loadStore()
  store.openTabs = (store.openTabs || []).filter((id) => id !== sessionId)
  if (store.activeSessionId === sessionId) {
    store.activeSessionId = store.openTabs[store.openTabs.length - 1] || ''
  }
  saveStore(store)
  return store
}

function setActiveSession(sessionId) {
  const store = loadStore()
  store.activeSessionId = sessionId
  saveStore(store)
  return store
}

function getSession(sessionId) {
  return loadStore().sessions[sessionId] || null
}

function getActiveSessionId() {
  return loadStore().activeSessionId || ''
}

async function deleteSession(sessionId) {
  try {
    await api.ensureLogin()
    await api.deleteSession(sessionId)
  } catch (e) { /* local only */ }
  const store = loadStore()
  delete store.sessions[sessionId]
  store.openTabs = (store.openTabs || []).filter((id) => id !== sessionId)
  store.historyIds = (store.historyIds || []).filter((id) => id !== sessionId)
  if (store.activeSessionId === sessionId) {
    store.activeSessionId = store.openTabs[0] || ''
  }
  saveStore(store)
}

module.exports = {
  MAX_OPEN_TABS,
  MAX_SESSIONS_HINT,
  STATUS_LABEL,
  hasPlanContent,
  hasEmptyPlanShell,
  stripPlanBlocks: sessionMessages.stripPlanBlocks,
  stripIntakeInterruptedPlan: sessionMessages.stripIntakeInterruptedPlan,
  normalizeSessionMessages: sessionMessages.normalizeSessionMessages,
  normalizeUiMessages: sessionMessages.normalizeUiMessages,
  mergeMessagesById,
  mergeChatTimeline,
  pickMessages,
  defaultChatState,
  defaultSession,
  loadStore,
  saveStore,
  getOpenTabs,
  getHistoryList,
  upsertSession,
  touchSession,
  saveChatState,
  createSession,
  fetchHistory,
  loadSessionDetail,
  addOpenTab,
  removeOpenTab,
  setActiveSession,
  getSession,
  getActiveSessionId,
  deleteSession,
  countSessions,
  canCreateSession,
  toSidebarItem
}

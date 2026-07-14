const api = require('../../utils/api')
const resolvePlanningPhase = api.resolvePlanningPhase
const isReplanConfirmMeta = api.isReplanConfirmMeta
const { createStreamRequest, createNarrateStreamRequest } = require('../../utils/stream')
const { normalizePlan, planToPlainText, extractPlanFromResponse, hasRenderableContent, hasRenderableDay } = require('../../utils/plan-json')
const {
  createTagPartitionParser,
  createThrottledRenderer,
  buildNarrateViewModel
} = require('../../utils/stream-md')
const logger = require('../../utils/logger')
const sessionStore = require('../../utils/session-store')
const sessionMessages = require('../../utils/session-messages')
const tripProfileUtil = require('../../utils/trip-profile')
const {
  isSupplementConfirmedAnswer,
  canReopenIntakeForLiveQuestion
} = require('../../utils/intake-gates')

function fingerprintTripProfile(profile) {
  if (typeof tripProfileUtil.tripProfileFingerprint === 'function') {
    return tripProfileUtil.tripProfileFingerprint(profile)
  }
  if (!profile) return ''
  try {
    return JSON.stringify(profile)
  } catch (e) {
    return ''
  }
}

/** sync 常带 planSteps 预算元数据；仅 used>0 或达上限才视为规划阶段 */
function isPlanStepsBlockingIntake(planSteps) {
  if (!planSteps) return false
  if (planSteps.limitReached) return true
  const used = planSteps.used != null ? planSteps.used : 0
  return used > 0
}

const POLL_INTERVAL = 1500
const ASK_POLL_IDLE_TIMEOUT = 30000
const PLANNING_STATE_KEY = 'planning_state'
const PLANNING_RESULT_KEY = 'planning_result'
const RESULT_FETCH_TIMEOUT = 5000
const PLANNING_WATCHDOG_MS = 120000
const RECONNECT_BASE_MS = 2000
const PLAN_RETRY_DELAY = 2000
const RECONNECT_MAX_MS = 60000
const RECONNECT_MAX_ATTEMPTS = 8

function extractDestination(query, session) {
  if (session && session.destination) return session.destination
  const q = (query || '').trim()
  if (!q) return ''
  const m = q.match(/^(.+?)(\d+)天$/)
  return m ? m[1] : q.replace(/\d+天$/, '').trim() || q
}

function buildNavTitle(query, session) {
  const dest = extractDestination(query, session)
  return dest ? dest + '旅行规划' : '旅行规划'
}

function stripIntakeInterruptedPlanMessages(messages) {
  const strip = sessionMessages.stripIntakeInterruptedPlan || sessionStore.stripIntakeInterruptedPlan
  if (typeof strip === 'function') return strip(messages)
  return (messages || []).filter((m) => {
    if (m.type === 'phase' || m.type === 'thinking') return false
    if (sessionMessages.isPlanMessage && sessionMessages.isPlanMessage(m)) return false
    if (m.role === 'assistant' && m.type === 'text') {
      const text = String(m.content || '')
      if (/如果你对行程满意|祝你旅途愉快/.test(text)) return false
      if (/规划好了|更新了行程|重新规划|我来为你规划|完整行程如下/.test(text)) return false
    }
    return true
  })
}


function dedupeMessageIds(messages) {
  const seen = new Set()
  let maxSeq = 0
  return (messages || []).map((m) => {
    let id = m && m.id
    const match = id && String(id).match(/^msg_(\d+)$/)
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10))
    if (!id || seen.has(id)) {
      maxSeq += 1
      id = 'msg_' + maxSeq
    }
    seen.add(id)
    return { ...m, id }
  })
}

function isItineraryConfirmation(text) {
  const t = (text || '').trim()
  if (!t) return false
  if (/重新规划|重新生成|再来一次|换一个|不满意|重做|调整|修改|改成|换成|改一下/.test(t)) return false
  return /^(好的|好呀|好啊|好哒|可以|行|ok|OK|没问题|满意|确认|就这样|不用改|不需要|不需要调整|行程可以|就这样吧|就按这个|就这个|赞同|同意|可以的|可以啊|蛮好|很好|不错)[。！!？?…~\s]*$/i.test(t)
    || /(满意|没问题|不需要改|不需要调整|行程可以|就按这个|就这样|可以了|挺好的|蛮好的)/.test(t)
}

function parseDurationFromText(text) {
  const t = (text || '').trim()
  if (!t) return null
  let m = t.match(/(\d+)\s*天\s*(\d+)\s*晚/)
  if (m) return { days: parseInt(m[1], 10), nights: parseInt(m[2], 10) }
  m = t.match(/(?:改成|改为|调整(?:为|到|成)|换成|改.*?为)\s*(\d+)\s*天(?:\s*(\d+)\s*晚)?/)
  if (m) {
    return {
      days: parseInt(m[1], 10),
      nights: m[2] != null ? parseInt(m[2], 10) : null
    }
  }
  m = t.match(/(\d+)\s*天(?:\s*(\d+)\s*晚)?/)
  if (m && /改|调整|缩短|延长|天数|天晚/.test(t)) {
    return {
      days: parseInt(m[1], 10),
      nights: m[2] != null ? parseInt(m[2], 10) : null
    }
  }
  return null
}

function isDurationChangeRequest(text) {
  return /(\d+)\s*天(?:\s*\d+\s*晚)?|改成.*?\d+\s*天|改为.*?\d+\s*天|调整.*?天数|缩短|延长/.test(text || '')
}

function buildDurationChangeQuery(text, duration) {
  if (!duration || !duration.days) return text
  const nightsPart = duration.nights != null ? `${duration.nights}晚` : ''
  return `${text}（请严格按${duration.days}天${nightsPart}重新安排行程，更新 summary 与每日 day 数量，勿保留原天数结构）`
}

Page({
  data: {
    messages: [],
    scrollTo: '',
    scrollTop: 0,
    loadingOlder: false,
    inputValue: '',
    inputFocus: false,
    inputPlaceholder: '输入消息...',
    awaitingReply: false,
    planComplete: false,
    postPlanChat: false,
    isThinking: false,
    userId: '',
    query: '',
    preferences: {},
    traceId: '',
    summary: '',
    days: [],
    showOverlay: false,
    showInterruptBanner: false,
    interruptBannerText: '网络连接中断，点击重试',
    sidebarOpen: false,
    openTabs: [],
    activeSessionId: '',
    activeTitle: '旅行规划',
    historyList: [],
    sessionCount: 0,
    maxSessions: sessionStore.MAX_OPEN_TABS,
    sessionId: '',
    sessionLoading: false,
    emptyState: true,
    askOptions: [],
    questionCategory: '',
    questionCategoryLabel: '',
    intakeProgress: null,
    intakeProgressLabel: '',
    showIntakeProgress: false,
    planSteps: null,
    planStepsHint: '',
    planStepLimitReached: false,
    planAdjustDisabled: false,
    planningPhase: '',
    planDegraded: false,
    degradedHint: '',
    // §18 双轨展示流（F-91）：权威行程仍用 days；本块仅 MD 阅读态
    narrateVisible: false,
    narrateStreaming: false,
    narrateThinkText: '',
    narrateHasThink: false,
    narrateHasContent: false,
    narrateHasReferences: false,
    narrateContentNodes: [],
    narrateReferencesNodes: [],
    statusBarHeight: 20,
    navBarHeight: 64,
    navContentHeight: 44,
    navPaddingRight: 96
  },

  _streamIncremental: true,
  _isPlanUpdate: false,
  _isRedesign: false,
  _streamBuffer: '',
  _isPageActive: true,
  _persistTimer: null,
  _narrateParser: null,
  _narrateRenderer: null,
  _narrateTask: null,
  _progressPlanTimer: null,

  _msgSeq: 0,
  _requestTask: null,
  _pollTimer: null,
  _pollIdleTimer: null,
  _askPollStopped: false,
  _finishTimer: null,
  _streamEnded: false,
  _streamHttpDone: false,
  _renderingPlan: false,
  _runtime: {},
  _reconnectAttempt: 0,
  _reconnectTimer: null,
  _reconnectCountdownTimer: null,
  _msgPage: 0,
  _msgHasMore: false,
  _msgLoading: false,
  _msgCursor: null,
  _intakeProgress: null,
  _intakePhaseDone: false,
  _tripProfileFingerprint: '',
  _planningWatchdogTimer: null,
  _planWatchdogFired: false,
  _pendingQuestionCategory: '',
  _planRefreshing: false,
  _intakeResuming: false,
  _intakeResolving: false,
  _syncPromise: null,
  _lastAnsweredQuestionId: '',

  onLoad(options) {
    this._skipShowRestore = true
    this._runtime = {}
    this._reconnectAttempt = 0
    this.initNavLayout()
    this.bootSessions(options || {})
    this._onNetworkChange = (res) => {
      if (res.isConnected && this.data.showInterruptBanner && !this.data.awaitingReply) {
        logger.log('planning', '网络恢复，触发重连')
        this.onRetry()
      }
    }
    wx.onNetworkStatusChange(this._onNetworkChange)
  },

  initNavLayout() {
    try {
      const sys = wx.getSystemInfoSync()
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBarHeight = sys.statusBarHeight || 20
      const gap = menu.top - statusBarHeight
      const navContentHeight = gap * 2 + menu.height
      const navBarHeight = statusBarHeight + navContentHeight
      const navPaddingRight = sys.windowWidth - menu.left + 8
      this.setData({
        statusBarHeight,
        navBarHeight,
        navContentHeight,
        navPaddingRight
      })
    } catch (e) {
      this.setData({
        statusBarHeight: 20,
        navBarHeight: 64,
        navContentHeight: 44,
        navPaddingRight: 96
      })
    }
  },

  sanitizeOpenTabs() {
    const store = sessionStore.loadStore()
    store.openTabs = (store.openTabs || []).filter((id) => store.sessions[id])
    if (store.activeSessionId && !store.sessions[store.activeSessionId]) {
      store.activeSessionId = store.openTabs[0] || ''
    }
    sessionStore.saveStore(store)
    return store
  },

  bootSessions(options) {
    try {
      api.ensureLogin().catch(() => {})

      const store = this.sanitizeOpenTabs()
      const openTabs = sessionStore.getOpenTabs(store)
      const historyList = sessionStore.getHistoryList(store)

      if (options.sessionId) {
        this.openSessionTab(options.sessionId, false)
      } else if (options.data) {
        this.createSessionFromPayload(this.parseLoadData(options))
      } else {
        logger.log('boot', '无 data/sessionId，redirect 到 index（忽略 openTabs 自动恢复）')
        wx.redirectTo({ url: '/pages/index/index' })
        return
      }

      sessionStore.fetchHistory().then((list) => {
        this.setData({ historyList: list })
        this.refreshShellUI()
      }).catch(() => {})

      this.refreshShellUI()
    } catch (e) {
      logger.log('boot', `启动失败 ${(e && e.message) || e}`)
      wx.redirectTo({ url: '/pages/index/index' })
    }
  },

  parseLoadData(options) {
    let query = ''
    let destination = ''
    let days = 0
    let preferences = {}

    if (options.data) {
      try {
        const payload = JSON.parse(decodeURIComponent(options.data))
        destination = (payload.destination || '').trim()
        days = payload.days != null ? parseInt(payload.days, 10) : 0
        if (!Number.isFinite(days) || days < 0) days = 0
        query = payload.query || (days > 0 ? `${destination}${days}天` : destination)
        preferences = payload.preferences || {}
        if (!destination && query) {
          const m = query.match(/^(.+?)(\d+)天$/)
          if (m) {
            destination = m[1]
            days = parseInt(m[2], 10)
          } else {
            destination = query.replace(/\d+天$/, '').trim() || query
          }
        }
      } catch (e) { /* ignore */ }
    }

    return { query, destination, days, preferences }
  },

  refreshShellUI() {
    const store = sessionStore.loadStore()
    const session = this.data.sessionId ? store.sessions[this.data.sessionId] : null
    this.setData({
      openTabs: sessionStore.getOpenTabs(store),
      activeSessionId: this.data.sessionId,
      activeTitle: buildNavTitle(this.data.query, session),
      emptyState: !this.data.sessionId,
      sessionCount: sessionStore.countSessions(store)
    })
  },

  refreshSidebarList() {
    return sessionStore.fetchHistory().then((list) => {
      this.setData({
        historyList: list,
        sessionCount: sessionStore.countSessions()
      })
    })
  },

  removeSessionById(sessionId) {
    if (sessionId === this.data.sessionId) {
      this.stopAskPollingPermanently()
      this.pauseActiveRuntime()
    }
    return sessionStore.deleteSession(sessionId).then(() => {
      if (sessionId === this.data.sessionId) {
        const store = sessionStore.loadStore()
        if (store.activeSessionId) {
          return this.openSessionTab(store.activeSessionId, false, { fromSidebarTabSwitch: true })
        }
        wx.redirectTo({ url: '/pages/index/index' })
        return
      }
    }).then(() => this.refreshSidebarList()).then(() => {
      this.setData({ openTabs: sessionStore.getOpenTabs(sessionStore.loadStore()) })
      this.refreshShellUI()
    })
  },

  persistActiveSession() {
    if (this._persistTimer) clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistActiveSessionNow()
      this._persistTimer = null
    }, 300)
  },

  flushPersistActiveSession() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer)
      this._persistTimer = null
    }
    this._persistActiveSessionNow()
  },

  _persistActiveSessionNow() {
    const sessionId = this.data.sessionId
    if (!sessionId) return
    const chat = sessionStore.defaultChatState()
    const keys = Object.keys(chat)
    keys.forEach((k) => { chat[k] = this.data[k] })
    chat.streamingBuffer = this._streamBuffer || ''
    const app = getApp()
    const session = sessionStore.getSession(sessionId)
    const intakeIncomplete = this.isIntakeIncomplete(session)
    const planResult = (!intakeIncomplete && (app.globalData.planResult
      || ((this.data.summary || (this.data.days && this.data.days.length))
        ? { summary: this.data.summary || '', days: this.data.days || [] }
        : null))) || null
    if (intakeIncomplete) {
      chat.planComplete = false
      chat.postPlanChat = false
    }
    let status = 'planning'
    if (this.data.planComplete && !intakeIncomplete) status = 'done'
    else if (this.data.awaitingReply) status = 'waiting_answer'
    else if (this.data.showInterruptBanner) status = 'interrupted'
    sessionStore.saveChatState(sessionId, chat, {
      query: this.data.query,
      preferences: this.data.preferences,
      traceId: this.data.traceId,
      userId: this.data.userId,
      summaryPreview: (this.data.summary || '').slice(0, 50),
      planResult,
      status,
      intakeProgress: this._intakeProgress || this.data.intakeProgress || null
    })
    if (this._runtime[sessionId]) {
      this._runtime[sessionId]._msgSeq = this._msgSeq
    }
  },

  pauseActiveRuntime() {
    this.stopPolling()
    this.stopFinishCheck()
    this.stopPlanningWatchdog()
    this.clearPollIdleTimer()
    const sessionId = this.data.sessionId
    if (sessionId) {
      this._runtime[sessionId] = {
        _msgSeq: this._msgSeq,
        _streamEnded: this._streamEnded,
        _streamHttpDone: this._streamHttpDone,
        _renderingPlan: this._renderingPlan,
        _streamIncremental: this._streamIncremental,
        _isPlanUpdate: this._isPlanUpdate,
        _isRedesign: this._isRedesign,
        _askPollStopped: this._askPollStopped,
        _requestTask: this._requestTask,
        _intakePhaseDone: this._intakePhaseDone,
        _tripProfileFingerprint: this._tripProfileFingerprint
      }
      if (this._requestTask && this._requestTask.abort) {
        this._requestTask.abort()
      }
      this._requestTask = null
    }
  },

  syncMsgSeqFromMessages(messages) {
    let maxSeq = this._msgSeq || 0
    ;(messages || []).forEach((m) => {
      const match = m.id && String(m.id).match(/^msg_(\d+)$/)
      if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10))
    })
    this._msgSeq = maxSeq
  },

  syncMsgPaginationFromSession(session) {
    const pag = session && session.msgPagination
    if (pag) {
      this._msgPage = pag.page != null ? pag.page : 0
      this._msgHasMore = !!pag.hasMore
      this._msgCursor = pag.nextCursor || null
    } else {
      this._msgPage = 0
      this._msgHasMore = false
      this._msgCursor = null
    }
    this._msgLoading = false
  },

  measureChatListHeight() {
    return new Promise((resolve) => {
      wx.createSelectorQuery().in(this)
        .select('.chat-list')
        .boundingClientRect((rect) => resolve((rect && rect.height) || 0))
        .exec()
    })
  },

  compensateScrollAfterPrepend(oldHeight) {
    if (!oldHeight) return Promise.resolve()
    return this.measureChatListHeight().then((newHeight) => {
      const delta = newHeight - oldHeight
      if (delta <= 0) return
      const nextTop = (this.data.scrollTop || 0) + delta
      this.setData({ scrollTop: nextTop, scrollTo: '' })
    })
  },

  onLoadOlderMessages() {
    if (this._msgLoading || !this._msgHasMore) return
    const { sessionId } = this.data
    if (!sessionId || String(sessionId).startsWith('sess_local_')) return

    this._msgLoading = true
    this.setData({ loadingOlder: true })
    const nextPage = (this._msgPage || 0) + 1
    const cursor = this._msgCursor
    const useCursor = !!(cursor && cursor.nextBeforeCreatedAtMs != null && cursor.nextBeforeMessageId)
    const requestOpts = { format: 'ui', size: 50 }
    if (useCursor) {
      requestOpts.beforeCreatedAt = cursor.nextBeforeCreatedAtMs
      requestOpts.beforeMessageId = cursor.nextBeforeMessageId
    } else {
      requestOpts.page = nextPage
    }

    this.measureChatListHeight().then((oldHeight) => {
      api.ensureLogin()
        .then(() => api.getSessionMessages(sessionId, requestOpts))
        .then((msgRes) => {
          const incoming = sessionStore.normalizeUiMessages((msgRes && msgRes.messages) || [])
          this._msgCursor = (msgRes && msgRes.nextCursor) || null
          if (!useCursor && msgRes && msgRes.page != null && msgRes.page >= 0) {
            this._msgPage = msgRes.page
          } else if (!useCursor) {
            this._msgPage = nextPage
          }
          this._msgHasMore = msgRes && msgRes.hasMore != null ? !!msgRes.hasMore : false
          if (!incoming.length) {
            this._msgHasMore = false
            return
          }
          const merged = sessionStore.mergeMessagesById(this.data.messages, incoming, { prepend: true })
          const msgPagination = {
            page: msgRes.page != null ? msgRes.page : (useCursor ? -1 : this._msgPage),
            size: msgRes.size != null ? msgRes.size : 50,
            total: msgRes.total != null ? msgRes.total : 0,
            hasMore: this._msgHasMore,
            nextCursor: this._msgCursor
          }
          sessionStore.touchSession(sessionId, { msgPagination })
          return new Promise((resolve) => {
            this.setData({ messages: merged }, () => {
              this.compensateScrollAfterPrepend(oldHeight).then(resolve)
            })
          })
        })
        .catch(() => {})
        .finally(() => {
          this._msgLoading = false
          this.setData({ loadingOlder: false })
          this.persistActiveSession()
        })
    })
  },

  hasPlanContent(messages) {
    return sessionStore.hasPlanContent(messages)
  },

  applySessionToView(session, options) {
    options = options || {}
    if (!session) return
    const chat = session.chat || sessionStore.defaultChatState()
    let messages = sessionMessages.normalizeSessionMessages(
      chat.messages || [],
      session.planResult,
      { skipPlanRebuild: !!(options.mergeWithCurrent && (this._requestTask || this._planRefreshing)) }
    )
    if (
      options.mergeWithCurrent
      && session.sessionId === this.data.sessionId
      && (this.data.messages || []).length
    ) {
      messages = sessionStore.mergeChatTimeline(this.data.messages, messages)
    }
    const msgStats = sessionMessages.summarizeMessages(messages, 'view')
    logger.log('session-messages', `[${session.sessionId}] applySessionToView ${JSON.stringify(msgStats)}`)
    if (sessionMessages.serverMissingAssistantDialog(messages)) {
      logger.log(
        'session-messages',
        `[${session.sessionId}] WARN 展示层缺 Agent 对话，非前端排版删除；请查 /sessions/${session.sessionId}/messages 是否含 assistant/text`
      )
    }
    this.syncMsgSeqFromMessages(messages)
    this.syncMsgPaginationFromSession(session)
    const runtime = this._runtime[session.sessionId] || {}
    const runtimeSeq = runtime._msgSeq || 0
    if (runtimeSeq > (this._msgSeq || 0)) {
      this._msgSeq = runtimeSeq
    }
    this._streamEnded = runtime._streamEnded || false
    this._streamHttpDone = runtime._streamHttpDone || false
    this._renderingPlan = runtime._renderingPlan || false
    this._streamIncremental = runtime._streamIncremental !== undefined ? runtime._streamIncremental : true
    this._isPlanUpdate = !!runtime._isPlanUpdate
    this._isRedesign = !!runtime._isRedesign
    this._askPollStopped = !!runtime._askPollStopped
      || (session.status === 'done' && (!!chat.planComplete || !!session.planResult) && !chat.awaitingReply)
    this._intakePhaseDone = runtime._intakePhaseDone != null
      ? !!runtime._intakePhaseDone
      : !!(session.status === 'done'
        || isPlanStepsBlockingIntake(session.planSteps)
        || isPlanStepsBlockingIntake(session.recovery && session.recovery.planSteps))
    this._tripProfileFingerprint = runtime._tripProfileFingerprint || ''
    this._requestTask = null

    const app = getApp()
    this._streamBuffer = chat.streamingBuffer || ''
    const intakeIncomplete = this.isIntakeIncomplete(session)
    if (session.planResult && !intakeIncomplete) {
      app.globalData.planResult = session.planResult
    }
    const doneSession = !intakeIncomplete && (
      session.status === 'done' || !!session.planResult
    )
    if (intakeIncomplete) {
      messages = stripIntakeInterruptedPlanMessages(messages)
      messages = messages.filter((m) => !sessionMessages.isLocalIntakeNoise(m))
      messages = sessionMessages.prepareIntakeDialog(messages, {
        legacyCollapse: sessionMessages.serverMissingAssistantDialog(messages)
      })
      app.globalData.planResult = null
    }
    messages = dedupeMessageIds(messages)
    const recovery = session.recovery || {}
    const inferredPending = this.inferPendingQuestionFromMessages(messages, recovery)
    const pendingQ = inferredPending || (recovery && recovery.pendingQuestion)
    const hasPendingQ = this.hasPendingIntakeQuestionInView(messages)
    const needsContinuation = intakeIncomplete && this.isIntakeNeedsContinuation(messages)
    const pendingQuestionText = pendingQ && (pendingQ.question || (typeof pendingQ === 'string' ? pendingQ : ''))
    if (!needsContinuation && hasPendingQ && pendingQuestionText) {
      const hasPending = messages.some(
        (m) => m.role === 'assistant' && m.type === 'text' && m.content === pendingQuestionText
      )
      if (!hasPending) {
        messages = sessionMessages.coalesceTrailingIntakeQuestions(messages)
        messages.push({
          id: 'msg_pending_q',
          role: 'assistant',
          type: 'text',
          content: pendingQuestionText
        })
      }
    }
    const pendingOptions = pendingQ && Array.isArray(pendingQ.options) ? pendingQ.options.filter(Boolean) : []
    const intakeAwaitingReply = intakeIncomplete && hasPendingQ && !needsContinuation
    if (runtime._intakePhaseDone == null) {
      this.syncIntakePhaseFromSync({
        planningPhase: session.planningPhase || recovery.planningPhase || recovery.phase || '',
        phase: recovery.phase || '',
        status: session.status,
        planSteps: session.planSteps || recovery.planSteps,
        hasQuestion: !!(recovery.pendingQuestion || (intakeIncomplete && hasPendingQ)),
        suggestedAction: recovery.suggestedAction || (hasPendingQ ? 'answer_question' : ''),
        intakeProgress: session.intakeProgress || recovery.intakeProgress
      })
    }
    if (doneSession && !options.mergeWithCurrent && !(this._requestTask || this._planRefreshing)) {
      messages = messages.filter((m) => m.type !== 'phase' && m.type !== 'thinking')
    }
    this.setData({
      sessionId: session.sessionId,
      userId: session.userId || app.getUserId() || '',
      query: session.query || '',
      preferences: session.preferences || {},
      emptyState: false,
      messages,
      scrollTo: messages.length ? messages[messages.length - 1].id : (chat.scrollTo || ''),
      scrollTop: 0,
      inputValue: chat.inputValue || '',
      inputFocus: false,
      inputPlaceholder: doneSession
        ? '继续提问，或要求调整方案…'
        : (intakeAwaitingReply ? '请输入您的回答' : (chat.inputPlaceholder || '输入消息...')),
      awaitingReply: intakeIncomplete ? intakeAwaitingReply : (!!chat.awaitingReply || this.isWaitingForUserAnswer(session)),
      askOptions: intakeAwaitingReply && pendingOptions.length ? pendingOptions : (chat.askOptions || []),
      questionCategory: intakeAwaitingReply && pendingQ ? (pendingQ.questionCategory || '') : (chat.questionCategory || ''),
      questionCategoryLabel: intakeAwaitingReply && pendingQ && pendingQ.questionCategory
        ? tripProfileUtil.categoryLabel(pendingQ.questionCategory)
        : (chat.questionCategoryLabel || ''),
      planComplete: doneSession,
      postPlanChat: doneSession,
      isThinking: !!chat.isThinking,
      traceId: session.traceId || (session.recovery && session.recovery.lastTraceId) || chat.traceId || '',
      summary: intakeIncomplete ? '' : (chat.summary || (session.planResult && session.planResult.summary) || ''),
      days: intakeIncomplete ? [] : (chat.days || (session.planResult && session.planResult.days) || []),
      showOverlay: !!chat.showOverlay,
      showInterruptBanner: session.status === 'interrupted' && !!chat.showInterruptBanner,
      planningPhase: session.planningPhase || resolvePlanningPhase(recovery) || '',
      planDegraded: !!(session.degraded || (recovery && recovery.degraded))
    })
    this.applyPlanSteps(
      session.planSteps
      || (session.recovery && session.recovery.planSteps)
      || null
    )
    this.refreshShellUI()
    if (!options.skipRecovery) {
      if (doneSession) {
        this.markIntakePhaseDone('session_done', { skipWatchdog: true })
      } else {
        this.ensureIntakeProgressForSession(session, messages)
      }
      if (!doneSession && hasPendingQ) {
        const pendingMeta = pendingQ && typeof pendingQ === 'object' ? pendingQ : {}
        if (pendingMeta.questionId) this._pendingQuestionId = pendingMeta.questionId
        if (pendingMeta.questionCategory) this._pendingQuestionCategory = pendingMeta.questionCategory
        this.activatePendingIntakeQuestion({
          options: pendingMeta.options || pendingOptions,
          questionId: pendingMeta.questionId || this._pendingQuestionId,
          questionCategory: pendingMeta.questionCategory || this._pendingQuestionCategory || this.data.questionCategory
        })
      }
      this.applySessionRecovery(session)
    }
  },

  applySessionRecovery(session) {
    if (!session) return
    if (this.data.awaitingReply && this.hasPendingIntakeQuestionInView()) {
      this.ensureIntakeProgressForSession(session, this.data.messages)
      return
    }
    const recovery = session.recovery || {}
    const chat = session.chat || {}
    const status = session.status

    if (this.isIntakeNeedsContinuation()) {
      logger.log('planning', `INTAKE 待续：用户已答，拉下一问 sessionId=${this.data.sessionId}`)
      this.setData({ awaitingReply: false, askOptions: [], inputPlaceholder: '输入消息...' })
      this.clearStaleIntakeWaitingState()
      this.ensureIntakeProgressForSession(session, this.data.messages)
      this.showThinking('正在准备下一个问题…')
      this.syncFromServer().then((sync) => {
        this.continueIntakeAfterAnswer(sync)
      })
      return
    }

    const planSteps = session.planSteps || recovery.planSteps
    if (planSteps) {
      this.applyPlanSteps(planSteps)
    }
    const action = recovery.suggestedAction || this.inferSuggestedAction(status)

    if (status === 'planning' || status === 'waiting_answer') {
      this.setData({ showInterruptBanner: false })
    }

    if (!this.isIntakeIncomplete(session) && (action === 'view_result' || (status === 'done' && session.planResult))) {
      if (session.degraded || (recovery && recovery.degraded)) {
        this.applyDegradedState(true)
      }
      this._streamEnded = true
      this._streamIncremental = true
      this._isPlanUpdate = false
      const msgs = this.data.messages || []
      const hasPlan = this.hasPlanContent(msgs)
      const emptyShell = sessionStore.hasEmptyPlanShell(msgs)
      const planResult = session.planResult || (
        (this.data.summary || (this.data.days && this.data.days.length))
          ? { summary: this.data.summary, days: this.data.days }
          : null
      )
      if (planResult && (!hasPlan || emptyShell)) {
        this.showPlanInChat(planResult)
        return
      }
      if (!this.data.planComplete && (hasPlan || planResult)) {
        this.setData({
          planComplete: true,
          postPlanChat: true,
          showIntakeProgress: false,
          intakeProgressLabel: '',
          questionCategory: '',
          questionCategoryLabel: '',
          summary: this.data.summary || (planResult && planResult.summary) || '',
          days: (this.data.days && this.data.days.length)
            ? this.data.days
            : ((planResult && planResult.days) || [])
        })
        this._intakeProgress = null
        this._intakeProgressFromServer = false
      }
      if (this.data.postPlanChat && !this._askPollStopped && (chat.awaitingReply || this.data.awaitingReply)) {
        this.startPolling()
      }
      return
    }

    if (action === 'answer_question' || status === 'waiting_answer' || recovery.pendingQuestion
      || (this.isIntakeIncomplete(session) && this.hasPendingIntakeQuestionInView())) {
      const pending = this.inferPendingQuestionFromMessages(this.data.messages, recovery)
      const question = pending && (pending.question || (typeof pending === 'string' ? pending : ''))
      const options = pending && pending.options ? pending.options : []
      const questionId = pending && pending.questionId ? pending.questionId : ''
      const questionCategory = pending && pending.questionCategory ? pending.questionCategory : ''
      const serverTraceId = session.traceId || recovery.lastTraceId || ''
      if (recovery.intakeProgress) {
        this.applyIntakeProgress(recovery.intakeProgress, session.preferences, { serverOnly: true, fromRecovery: true })
      } else if (session.intakeProgress) {
        this.applyIntakeProgress(session.intakeProgress, session.preferences, { serverOnly: true, fromRecovery: true })
      } else if (session.preferences && session.preferences.tripProfile) {
        this.applyIntakeProgress(null, session.preferences, { fromRecovery: true })
      } else {
        this.ensureIntakeProgressForSession(session, this.data.messages)
      }
      if (serverTraceId) {
        this.applyServerTraceId(serverTraceId)
      }
      if (question) {
        if (this.shouldSkipIntakeQuestion({
          question, questionId, questionCategory, fromRecovery: true
        })) {
          this.syncFromServer().then((sync) => this.continueIntakeAfterAnswer(sync))
          return
        }
        if (!this.canPresentIntakeQuestion({ fromRecovery: true, liveQuestion: true })) {
          logger.log('intake', `恢复追问被规划阶段门禁拦截 sessionId=${this.data.sessionId}`)
          if (this._intakePhaseDone && !this.data.planComplete) {
            this.scheduleFinishCheck()
          }
          return
        }
        if (this.hasPendingIntakeQuestionInView()) {
          if (questionId) this._pendingQuestionId = questionId
          if (questionCategory) this._pendingQuestionCategory = questionCategory
          this.activatePendingIntakeQuestion({ options, questionId, questionCategory })
          return
        }
        this.presentIntakeQuestion(question, {
          options, questionId, questionCategory, fromRecovery: true, liveQuestion: true
        })
        return
      }
      if (status === 'waiting_answer' || recovery.pendingQuestion) {
        this.syncFromServer().then((sync) => {
          if (this.isIntakeNeedsContinuation()) {
            this.continueIntakeAfterAnswer(sync)
          } else if (!this.data.awaitingReply) {
            this.startPolling()
          }
        })
        return
      }
    }

    if (action === 'resume_plan' || status === 'interrupted' || status === 'planning') {
      if (planSteps && planSteps.limitReached) {
        this.setData({ showInterruptBanner: false })
        return
      }
      if (this.isWaitingForUserAnswer(session)) {
        if (!this.data.awaitingReply) {
          this.syncFromServer()
        }
        return
      }
      if (this.resumeIntakeIfNeeded(session)) return
    }

    if (action === 'resume_plan' || status === 'interrupted') {
      if (this.isWaitingForUserAnswer(session)) return
      this.setData({ showInterruptBanner: true })
      return
    }

    if (action === 'start_plan' && status === 'created' && !chat.planComplete && !this._streamEnded && !this.data.isThinking && !this._requestTask) {
      const msgs = this.data.messages || []
      if (!msgs.length && session.query) {
        this.startPlanning(session.query, session.preferences || {}, getApp().getUserId(), { incremental: false })
        return
      }
    }

    if (status === 'planning' && !chat.planComplete && !this.data.awaitingReply && !this._askPollStopped) {
      this.startPolling()
    }
    if (chat.awaitingReply && !this._askPollStopped) {
      this.resetPollIdleTimer()
      this.startPolling()
    }
  },

  inferSuggestedAction(status) {
    const map = {
      created: 'start_plan',
      waiting_answer: 'answer_question',
      done: 'view_result',
      interrupted: 'resume_plan',
      planning: 'resume_plan'
    }
    return map[status] || ''
  },

  applyServerTraceId(traceId) {
    if (!traceId) return
    const app = getApp()
    app.globalData.currentTraceId = traceId
    this.setData({ traceId })
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, { traceId })
    }
  },

  isPlanningPhaseBlocked(context) {
    if (!context) return false
    if (isPlanStepsBlockingIntake(context.planSteps)) return true
    const phase = resolvePlanningPhase(context)
    if (phase === 'planning' || phase === 'done') return true
    return phase === 'research' || phase === 'detail' || phase === 'skeleton' || phase === 'finish'
  },

  isIntakePhaseFromSync(sync) {
    if (!sync || isPlanStepsBlockingIntake(sync.planSteps)) return false
    const phase = resolvePlanningPhase(sync)
    if (phase === 'intake') return true
    if (phase === 'planning' || phase === 'done') return false
    if (this.syncPayloadWaitingAnswer(sync)) return true
    return phase === 'waiting_answer'
  },

  isIntakePhaseOverFromSync(sync) {
    if (!sync) return false
    if (this.isPlanningPhaseBlocked({ phase: sync.phase, planSteps: sync.planSteps })) return true
    if (sync.status === 'done') return true
    return !sync.hasQuestion
      && sync.suggestedAction !== 'answer_question'
      && tripProfileUtil.isIntakeProgressComplete(sync.intakeProgress)
  },

  syncIntakePhaseFromSync(sync, options) {
    options = options || {}
    if (!sync) return
    if (options.skipMarkDone) {
      if (this.isIntakePhaseFromSync(sync) && this._intakePhaseDone) {
        this._intakePhaseDone = false
        this.stopPlanningWatchdog()
      }
      return
    }
    if (this.isIntakePhaseFromSync(sync)) {
      if (this._intakePhaseDone) {
        this._intakePhaseDone = false
        this.stopPlanningWatchdog()
      }
      return
    }
    if (this.isIntakePhaseOverFromSync(sync) && !this._intakePhaseDone) {
      const skipWatchdog = sync.status === 'done' || this.data.planComplete
      this.markIntakePhaseDone('sync_align', { skipWatchdog })
    }
  },

  canPresentIntakeQuestion(meta) {
    meta = meta || {}
    const sync = meta.sync
    if (isReplanConfirmMeta(meta)
      || (sync && isReplanConfirmMeta({ question: sync.question, questionCategory: sync.questionCategory }))) {
      return true
    }
    if (meta.forceAsk) {
      return !this.data.postPlanChat && !this.data.planComplete
    }
    if (this.data.postPlanChat || this.data.planComplete) return false
    const serverPhase = resolvePlanningPhase({
      planningPhase: (sync && sync.planningPhase) || this.data.planningPhase
    })
    if (serverPhase === 'planning' || serverPhase === 'done') return false
    if (isPlanStepsBlockingIntake(this.data.planSteps)) return false
    const liveQuestion = meta.liveQuestion || !!(meta.sync && meta.sync.hasQuestion)
    if (liveQuestion || this.isIntakeNeedsContinuation()) {
      if (!canReopenIntakeForLiveQuestion({
        intakePhaseDone: this._intakePhaseDone,
        intakeIncomplete: this.isIntakeIncomplete(),
        planningPhase: serverPhase || this.data.planningPhase,
        planComplete: this.data.planComplete,
        postPlanChat: this.data.postPlanChat,
        isThinking: this.data.isThinking
      })) {
        return false
      }
      if (this._intakePhaseDone) {
        this._intakePhaseDone = false
        this.stopPlanningWatchdog()
      }
      return true
    }
    if (this._intakePhaseDone) return false
    if (meta.sync && this.isPlanningPhaseBlocked({ phase: meta.sync.phase, planSteps: meta.sync.planSteps })) {
      return false
    }
    const session = this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null
    if (session) {
      const recovery = session.recovery || {}
      if (isPlanStepsBlockingIntake(session.planSteps) || isPlanStepsBlockingIntake(recovery.planSteps)) {
        return false
      }
      if (this.isPlanningPhaseBlocked({ phase: recovery.phase })) return false
    }
    return this.isIntakeIncomplete(session)
  },

  markIntakePhaseDone(reason, options) {
    options = options || {}
    const entering = !this._intakePhaseDone
    this._intakePhaseDone = true
    const tp = (this.data.preferences || {}).tripProfile
    if (tp) this._tripProfileFingerprint = fingerprintTripProfile(tp)
    this.clearIntakeProgressUi()
    this.clearAskReplyUi()
    if (entering && !options.skipWatchdog && !this.data.planComplete) {
      this.startPlanningWatchdog()
    }
    if (entering) {
      this.setData({ planningPhase: 'planning' })
      logger.log('planning', `INTAKE 结束 → 规划阶段 reason=${reason || '-'} sessionId=${this.data.sessionId}`)
    }
  },

  clearAskReplyUi() {
    this.setData({
      awaitingReply: false,
      askOptions: [],
      questionCategory: '',
      questionCategoryLabel: '',
      inputPlaceholder: (this.data.postPlanChat || this.data.planComplete)
        ? '继续提问，或要求调整方案…'
        : '输入消息...'
    })
  },

  reopenIntakeForProfileChange() {
    this._intakePhaseDone = false
    this.stopPlanningWatchdog()
    logger.log('planning', `旅游要素变更，重新开放 INTAKE sessionId=${this.data.sessionId}`)
  },

  hasTripProfileChanged(profile) {
    const fp = fingerprintTripProfile(profile)
    return !!(fp && this._tripProfileFingerprint && fp !== this._tripProfileFingerprint)
  },

  checkTripProfileChangeFromSync(sync) {
    if (!sync || !sync.preferences || !sync.preferences.tripProfile) return false
    if (!this._tripProfileFingerprint) return false
    if (!this.hasTripProfileChanged(sync.preferences.tripProfile)) return false
    if (sync.hasQuestion && isReplanConfirmMeta({
      question: sync.question,
      questionCategory: sync.questionCategory
    })) {
      const merged = { ...this.data.preferences, ...sync.preferences }
      this.setData({ preferences: merged })
      if (this.data.sessionId) {
        sessionStore.touchSession(this.data.sessionId, { preferences: merged })
      }
      return false
    }
    this.reopenIntakeForProfileChange()
    const merged = { ...this.data.preferences, ...sync.preferences }
    this.setData({ preferences: merged })
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, { preferences: merged })
    }
    return true
  },

  startPlanningWatchdog() {
    this.stopPlanningWatchdog()
    if (this.data.planComplete || !this._intakePhaseDone) return
    this._planWatchdogFired = false
    this._planningWatchdogTimer = setTimeout(() => {
      this.handlePlanningWatchdogTimeout()
    }, PLANNING_WATCHDOG_MS)
  },

  stopPlanningWatchdog() {
    if (this._planningWatchdogTimer) {
      clearTimeout(this._planningWatchdogTimer)
      this._planningWatchdogTimer = null
    }
  },

  handlePlanningWatchdogTimeout() {
    if (!this._isPageActive || this.data.planComplete) return
    if (this.isIntakeIncomplete()) return
    logger.log('planning', `规划 ${PLANNING_WATCHDOG_MS}ms 超时，降级 finish sessionId=${this.data.sessionId}`)
    this._planWatchdogFired = true
    this.loadPlanResult({ forceFinalize: true })
  },

  applyPlanningFallbackFinish(err) {
    this.stopPlanningWatchdog()
    this.stopPolling()
    this.stopFinishCheck()
    this.removeThinking()
    this._renderingPlan = false
    const fromBuffer = this.resolvePlanFromBuffer()
    if (fromBuffer && hasRenderableContent(fromBuffer)) {
      this.showPlanInChat(fromBuffer)
      return
    }
    const hint = (err && err.message) || ''
    const content = hint && hint !== 'not_ready' && hint !== 'timeout'
      ? `规划耗时较长：${hint}。如需完整方案请稍后重试或重新规划。`
      : '规划耗时较长，暂未获取完整行程。如需更完整方案请稍后重试或重新规划。'
    this._streamEnded = true
    this._intakePhaseDone = true
    this._askPollStopped = true
    this.setData({
      planComplete: true,
      postPlanChat: true,
      showIntakeProgress: false,
      intakeProgressLabel: '',
      isThinking: false,
      showOverlay: false,
      inputPlaceholder: '继续提问，或要求调整方案…'
    })
    this.pushMessage({ role: 'assistant', type: 'text', content })
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, { status: 'done' })
    }
    this.persistActiveSession()
    this.savePlanningState('done')
  },

  shouldEnterPlanningFromSync(sync) {
    return this.isIntakePhaseOverFromSync(sync) && !this.isIntakePhaseFromSync(sync)
  },

  isIntakeIncomplete(session) {
    session = session || (this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null) || {}
    if (session.status === 'done' && session.planResult) return false
    const sessionPhase = resolvePlanningPhase(session)
    if (sessionPhase === 'planning' || sessionPhase === 'done') return false
    const recovery = session.recovery || {}
    const planSteps = session.planSteps || recovery.planSteps || this.data.planSteps
    if (isPlanStepsBlockingIntake(planSteps)) return false
    if (this._intakePhaseDone) return false
    const phase = String(recovery.phase || '').toLowerCase()
    if (this.isPlanningPhaseBlocked({ phase }) && !this.isIntakeNeedsContinuation()) return false
    if (session.status === 'waiting_answer') return true
    if (phase === 'intake' || phase === 'waiting_answer') return true
    if (recovery.pendingQuestion) return true
    if (recovery.suggestedAction === 'answer_question') return true
    if (this.data.awaitingReply && this.hasPendingIntakeQuestionInView()) return true

    const serverProgress = recovery.intakeProgress || session.intakeProgress
    if (serverProgress) {
      if (tripProfileUtil.isIntakeProgressComplete(serverProgress)) return false
      const total = serverProgress.total != null ? serverProgress.total : tripProfileUtil.INTAKE_TOTAL
      if (Array.isArray(serverProgress.missing) && serverProgress.missing.length > 0) return true
      const filled = serverProgress.filled != null ? serverProgress.filled : 0
      if (filled < total) return true
    } else if (session.preferences && session.preferences.tripProfile) {
      const est = tripProfileUtil.estimateIntakeProgress(session.preferences.tripProfile)
      if (est.filled < est.total) return true
    }

    if (this.isIntakeNeedsContinuation()) return true
    return false
  },

  isWaitingForUserAnswer(session) {
    session = session || (this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null) || {}
    if (this.isIntakeIncomplete(session) && this.isIntakeNeedsContinuation()) return false
    if (this.data.awaitingReply && this.hasPendingIntakeQuestionInView()) return true
    if (session.status === 'waiting_answer') {
      return this.hasPendingIntakeQuestionInView()
    }
    const recovery = session.recovery || {}
    if (recovery.pendingQuestion) {
      return this.hasPendingIntakeQuestionInView()
    }
    if (String(recovery.phase || '').toLowerCase() === 'waiting_answer') {
      return this.hasPendingIntakeQuestionInView()
    }
    if (recovery.suggestedAction === 'answer_question') {
      return this.hasPendingIntakeQuestionInView()
    }
    return false
  },

  hasPendingIntakeQuestionInView(messages) {
    messages = messages || this.data.messages || []
    if (!messages.length) return false
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && (m.type === 'text' || m.type === 'answer')) {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) {
      const last = messages[messages.length - 1]
      return !!(last && last.role === 'assistant' && last.type === 'text')
    }
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i].type === 'text') return true
    }
    return false
  },

  isIntakeNeedsContinuation(messages) {
    messages = messages || this.data.messages || []
    if (!messages.length) return false
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') return false
    if (this.hasPendingIntakeQuestionInView(messages)) return false

    const session = this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null
    const recovery = (session && session.recovery) || {}
    if (session && session.status === 'done') return false
    if (isPlanStepsBlockingIntake(session && session.planSteps)) return false
    if (isPlanStepsBlockingIntake(recovery.planSteps) || isPlanStepsBlockingIntake(this.data.planSteps)) {
      return false
    }
    if (this._intakePhaseDone) return false
    if (recovery.pendingQuestion) return false
    const serverProgress = (session && session.intakeProgress) || recovery.intakeProgress
    if (serverProgress && tripProfileUtil.isIntakeProgressComplete(serverProgress)) return false
    return true
  },

  syncPayloadWaitingAnswer(sync) {
    if (!sync) return false
    return !!(
      sync.hasQuestion
      || sync.status === 'waiting_answer'
      || sync.suggestedAction === 'answer_question'
    )
  },

  resolveResumePlanOptions() {
    const session = sessionStore.getSession(this.data.sessionId) || {}
    if (this.isIntakeIncomplete(session)) {
      return { incremental: false, resume: true, retry: true }
    }
    const hadPlan = this.data.planComplete
      || !!(this.data.summary || (this.data.days && this.data.days.length))
      || this.hasPlanContent(this.data.messages)
    return {
      incremental: hadPlan,
      resume: true,
      retry: true
    }
  },

  resumeIntakeIfNeeded(session) {
    if (!session || this._requestTask || this._intakeResuming || this._intakeResolving || this.data.isThinking) return false
    if (this.data.awaitingReply || this.data.planComplete || this.hasPendingIntakeQuestionInView()) return false
    if (this.isWaitingForUserAnswer(session)) return true
    if (!this.isIntakeIncomplete(session)) return false
    const recovery = session.recovery || {}
    if (recovery.intakeProgress) {
      this.applyIntakeProgress(recovery.intakeProgress, session.preferences, { serverOnly: true })
    } else if (session.preferences && session.preferences.tripProfile) {
      this.applyIntakeProgress(null, session.preferences)
    }
    const traceId = session.traceId || (recovery.lastTraceId || '')
    if (traceId) this.applyServerTraceId(traceId)
    this._intakeResuming = true
    this.syncFromServer().then((sync) => {
      if (this._requestTask || this.data.awaitingReply) return
      if (this.syncPayloadWaitingAnswer(sync)) return
      if (this.isWaitingForUserAnswer(sessionStore.getSession(this.data.sessionId))) return
      logger.log('planning', `INTAKE 未完成，ensureIntakeQuestion sessionId=${this.data.sessionId}`)
      this.ensureIntakeQuestion()
    }).finally(() => {
      this._intakeResuming = false
    })
    return true
  },

  applyIntakeProgress(progress, preferences, options) {
    options = options || {}
    const serverPhase = resolvePlanningPhase({ planningPhase: this.data.planningPhase })
    if (serverPhase && serverPhase !== 'intake' && !options.forceIntake) {
      this.clearIntakeProgressUi()
      return
    }
    if (this.data.planComplete || this.data.postPlanChat || this._intakePhaseDone
      || isPlanStepsBlockingIntake(this.data.planSteps)) {
      this.clearIntakeProgressUi()
      return
    }
    let next = progress
    let fromServer = !!progress
    if (!next && !options.serverOnly && preferences && preferences.tripProfile) {
      next = tripProfileUtil.estimateIntakeProgress(preferences.tripProfile)
      fromServer = false
    }
    if (!next && options.fromRecovery && preferences && preferences.tripProfile) {
      next = tripProfileUtil.estimateIntakeProgress(preferences.tripProfile)
      fromServer = false
    }
    if (!next && options.fromRecovery && options.dialogMessages && options.dialogMessages.length) {
      next = tripProfileUtil.estimateIntakeProgressFromDialog(options.dialogMessages)
      fromServer = !!next
    }
    if (!next) {
      this.clearIntakeProgressUi()
      return
    }
    this._intakeProgress = next
    this._intakeProgressFromServer = fromServer
    const filled = next.filled != null ? next.filled : 0
    const total = next.total != null ? next.total : tripProfileUtil.INTAKE_TOTAL
    const show = filled < total
    this.setData({
      intakeProgress: next,
      intakeProgressLabel: tripProfileUtil.formatIntakeProgressLabel(next),
      showIntakeProgress: show
    })
  },

  ensureIntakeProgressForSession(session, messages) {
    session = session || (this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null) || {}
    messages = messages || this.data.messages || []
    if (!this.isIntakeIncomplete(session)) {
      this.clearIntakeProgressUi()
      return
    }
    const recovery = session.recovery || {}
    const serverProgress = session.intakeProgress || recovery.intakeProgress
    if (serverProgress) {
      this.applyIntakeProgress(serverProgress, session.preferences, { serverOnly: true, fromRecovery: true })
      if (this.data.showIntakeProgress) return
    }
    if (session.preferences && session.preferences.tripProfile) {
      this.applyIntakeProgress(null, session.preferences, { fromRecovery: true })
      if (this.data.showIntakeProgress) return
    }
    const dialogProgress = tripProfileUtil.estimateIntakeProgressFromDialog(messages)
    if (dialogProgress) {
      this.applyIntakeProgress(dialogProgress, session.preferences, {
        serverOnly: true,
        fromRecovery: true,
        dialogMessages: messages
      })
    }
  },

  inferPendingQuestionFromMessages(messages, recovery) {
    recovery = recovery || {}
    const pending = recovery.pendingQuestion
    if (pending && (pending.question || typeof pending === 'string')) {
      return typeof pending === 'string'
        ? { question: pending, options: [], questionId: '', questionCategory: '' }
        : pending
    }
    messages = messages || []
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && (m.type === 'text' || m.type === 'answer')) {
        lastUserIdx = i
        break
      }
    }
    for (let i = messages.length - 1; i > lastUserIdx; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && m.type === 'text') {
        const question = String(m.content || '').trim()
        if (!question) return null
        return {
          question,
          options: [],
          questionId: m.questionId || '',
          questionCategory: m.questionCategory || ''
        }
      }
    }
    return null
  },

  clearIntakeProgressUi() {
    this._intakeProgress = null
    this._intakeProgressFromServer = false
    this.setData({
      intakeProgress: null,
      intakeProgressLabel: '',
      showIntakeProgress: false,
      questionCategory: '',
      questionCategoryLabel: ''
    })
  },

  applyPlanSteps(planSteps) {
    if (!planSteps) {
      this.setData({
        planSteps: null,
        planStepsHint: '',
        planStepLimitReached: false,
        planAdjustDisabled: false
      })
      return
    }
    if (isPlanStepsBlockingIntake(planSteps)) {
      this.markIntakePhaseDone('plan_steps')
    }
    const limitReached = !!planSteps.limitReached
    const hint = String(planSteps.hint || '').trim()
    const remaining = planSteps.remaining
    const showNearLimitHint = !limitReached && hint && remaining != null && remaining <= 3
    const patch = {
      planSteps,
      planStepsHint: limitReached ? hint : (showNearLimitHint ? hint : ''),
      planStepLimitReached: limitReached,
      planAdjustDisabled: limitReached
    }
    if (limitReached && this.data.planComplete) {
      patch.inputPlaceholder = hint || '已达规划次数上限，请新建会话'
    }
    this.setData(patch)
  },

  applyDegradedState(degraded, hint) {
    const text = hint || '规划超时，当前为部分结果，建议核对后使用或重新规划。'
    this.setData({
      planDegraded: !!degraded,
      degradedHint: degraded ? text : ''
    })
  },

  handleStreamDegraded(payload) {
    this._planDegraded = true
    const secs = payload && payload.timeoutSeconds
    const hint = secs
      ? `规划超过 ${secs} 秒未完成，已展示部分结果，建议核对后使用。`
      : '规划超时，已展示部分结果，建议核对后使用。'
    this.applyDegradedState(true, hint)
  },

  isPlanStepLimitError(err) {
    if (this.data.planStepLimitReached) return true
    const body = (err && err.body) || {}
    if (body.planSteps && body.planSteps.limitReached) return true
    const msg = (err && err.message) || body.message || body.error || ''
    return api.isPlanStepLimitMessage(msg)
  },

  isQuestionAlreadyShown(question) {
    if (!question) return false
    return (this.data.messages || []).some(
      (m) => m.role === 'assistant' && m.type === 'text' && m.content === question
    )
  },

  getLastIntakeQuestion() {
    const msgs = sessionMessages.coalesceTrailingIntakeQuestions(this.data.messages || [])
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'assistant' && m.type === 'text') return String(m.content || '')
    }
    return ''
  },

  getPendingIntakeQuestionMessage(messages) {
    messages = messages || this.data.messages || []
    if (!this.hasPendingIntakeQuestionInView(messages)) return null
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && (m.type === 'text' || m.type === 'answer')) {
        lastUserIdx = i
        break
      }
    }
    for (let i = messages.length - 1; i > lastUserIdx; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && m.type === 'text') return m
    }
    return null
  },

  activatePendingIntakeQuestion(meta) {
    meta = meta || {}
    if (!this.canPresentIntakeQuestion({ ...meta, fromRecovery: true, liveQuestion: true })) {
      logger.log('intake', '规划已启动，忽略恢复待答快捷按钮')
      this.clearAskReplyUi()
      return false
    }
    const pendingMsg = this.getPendingIntakeQuestionMessage()
    if (!pendingMsg) return false
    const question = String(pendingMsg.content || '').trim()
    if (!question) return false
    let options = Array.isArray(meta.options) ? meta.options.filter(Boolean) : []
    const category = meta.questionCategory || this._pendingQuestionCategory || this.data.questionCategory || ''
    if (!options.length && category) {
      options = tripProfileUtil.defaultOptionsForCategory(category)
    }
    if (meta.questionId) this._pendingQuestionId = meta.questionId
    if (category) this._pendingQuestionCategory = category
    this.setData({
      awaitingReply: true,
      askOptions: options.length ? options : (this.data.askOptions || []),
      questionCategory: category,
      questionCategoryLabel: tripProfileUtil.categoryLabel(category),
      inputPlaceholder: '请输入您的回答',
      scrollTo: pendingMsg.id,
      isThinking: false
    })
    logger.log('intake', `恢复待答 UI question=${question.slice(0, 40)} category=${category || '-'}`)
    return true
  },

  shouldSkipIntakeQuestion(meta) {
    meta = meta || {}
    if (meta.forceAsk || meta.replace) return false
    // live 轮询 / sync 永不按 category 本地 skip
    if (!meta.fromRecovery) return false
    const category = meta.questionCategory || meta.category || ''
    if (!category || !this._intakeProgressFromServer) return false
    const progress = this._intakeProgress || this.data.intakeProgress
    if (!progress || !tripProfileUtil.isCategoryConfirmed(category, progress)) return false
    logger.log('intake', `冷恢复跳过已确认 category=${category}`)
    return true
  },

  promptMissingCategory(category) {
    if (!category) return false
    const question = tripProfileUtil.promptForCategory(category, this.data.query)
    this.askInChat(question, {
      questionCategory: category,
      options: tripProfileUtil.defaultOptionsForCategory(category),
      forceAsk: true,
      liveQuestion: true
    })
    return true
  },

  resolveIntakeQuestionFallback(sync) {
    if (!sync || sync.hasQuestion) return null
    const progress = sync.intakeProgress || this._intakeProgress || this.data.intakeProgress
    if (progress && progress.missing && progress.missing.length) {
      return { questionCategory: progress.missing[0] }
    }
    const session = this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null
    const recovery = (session && session.recovery) || {}
    const pending = recovery.pendingQuestion
    if (pending && (pending.questionCategory || pending.category)) {
      return { questionCategory: pending.questionCategory || pending.category }
    }
    return null
  },

  resumeIntakeStream() {
    if (this._requestTask) return
    const { query, preferences, userId } = this.data
    logger.log('planning', `INTAKE 无待答追问，resume 流 sessionId=${this.data.sessionId}`)
    this.startPlanning(query, preferences, userId, {
      incremental: false,
      resume: true,
      retry: true,
      afterIntakeAnswer: true
    })
  },

  clearStaleIntakeWaitingState() {
    const sessionId = this.data.sessionId
    if (!sessionId) return
    const session = sessionStore.getSession(sessionId) || {}
    const recovery = {
      ...(session.recovery || {}),
      pendingQuestion: null,
      suggestedAction: 'resume_plan',
      phase: 'intake'
    }
    sessionStore.touchSession(sessionId, {
      status: 'waiting_answer',
      recovery,
      chat: { ...(session.chat || {}), awaitingReply: false }
    })
  },

  isStaleIntakeQuestion(sync, answeredQuestionId) {
    if (!sync || !sync.question) return true
    const q = String(sync.question).trim()
    if (!q) return true
    const qid = sync.questionId || ''
    if (answeredQuestionId && qid && qid === answeredQuestionId) return true
    if (this._lastAnsweredQuestionId && qid && qid === this._lastAnsweredQuestionId) return true
    // 界面已有相同待答气泡：恢复输入态，勿重复 append
    if (this.hasPendingIntakeQuestionInView() && q === this.getLastIntakeQuestion()) return true
    return false
  },

  continueIntakeAfterAnswer(sync, answeredQuestionId) {
    if (!this._isPageActive) return
    if (this.data.awaitingReply && this.hasPendingIntakeQuestionInView()) return
    if (sync && sync.hasQuestion && sync.question && !this.isStaleIntakeQuestion(sync, answeredQuestionId)) {
      logger.log('planning', `INTAKE 继续：sync 返回新追问 sessionId=${this.data.sessionId}`)
      this.presentIntakeQuestion(sync.question, {
        options: sync.options || [],
        questionId: sync.questionId || '',
        questionCategory: sync.questionCategory || '',
        sync,
        liveQuestion: true
      })
      return
    }
    if (sync && sync.hasQuestion && sync.question && this.isStaleIntakeQuestion(sync, answeredQuestionId)) {
      if (!this.canPresentIntakeQuestion({ liveQuestion: true, sync })) {
        this.clearAskReplyUi()
        return
      }
      if (this.activatePendingIntakeQuestion({
        options: sync.options || [],
        questionId: sync.questionId || '',
        questionCategory: sync.questionCategory || ''
      })) return
    }
    if (this.isIntakeIncomplete()) {
      this.removeThinking()
      if (sync && (sync.status === 'waiting_answer' || sync.suggestedAction === 'answer_question')) {
        const fallback = this.resolveIntakeQuestionFallback(sync)
        if (fallback) {
          logger.log('planning', `INTAKE 后端无 pending，按 missing 补问 category=${fallback.questionCategory || '-'} sessionId=${this.data.sessionId}`)
          this.promptMissingCategory(fallback.questionCategory)
          return
        }
        logger.log('planning', `INTAKE 等待后端下一问，仅轮询 sessionId=${this.data.sessionId}`)
        if (!this._askPollStopped) this.startPolling()
        return
      }
      if (this._requestTask && !this._streamHttpDone) {
        logger.log('planning', `INTAKE 同连接进行中，禁止重复 POST /plan sessionId=${this.data.sessionId}`)
        if (!this._askPollStopped) this.startPolling()
        return
      }
      if (this._streamHttpDone && sync && (sync.suggestedAction === 'resume_plan' || sync.status === 'interrupted')) {
        logger.log('planning', `INTAKE 流已结束，resume POST /plan sessionId=${this.data.sessionId}`)
        this.resumeIntakeStream()
      } else if (!this._askPollStopped) {
        this.startPolling()
      }
      return
    }
    logger.log('planning', `继续 resume POST /plan sessionId=${this.data.sessionId}`)
    this.scheduleFinishCheck()
    this.resumeIntakeStream()
    if (!this._askPollStopped) this.startPolling()
  },

  ensureIntakeQuestion() {
    if (!this._isPageActive) return
    if (this.data.awaitingReply || this._intakeResolving || this.hasPendingIntakeQuestionInView()) return
    if (this._requestTask && !this._streamHttpDone) return
    if (!this.isIntakeIncomplete()) return
    this._intakeResolving = true
    this.removeThinking()
    this.stopPolling()
    this.stopFinishCheck()
    this.syncFromServer().then((sync) => {
      if (!this._isPageActive) return
      if (this.data.awaitingReply) return
      if (this._requestTask && !this._streamHttpDone) return
      this.continueIntakeAfterAnswer(sync)
    }).finally(() => {
      this._intakeResolving = false
    })
  },

  maybeAskInChat(question, meta) {
    meta = meta || {}
    if (!question) return false
    if (this._planRefreshing) return false
    this.presentIntakeQuestion(question, meta)
    return true
  },

  syncTraceIdFromServer() {
    return this.syncFromServer().then((sync) => {
      return (sync && sync.traceId) || this.data.traceId || ''
    })
  },

  syncFromServer() {
    const { sessionId } = this.data
    if (!sessionId || String(sessionId).startsWith('sess_local_')) {
      return Promise.resolve(null)
    }
    if (this._syncPromise) return this._syncPromise
    this._syncPromise = api.ensureLogin()
      .then(() => api.syncSession(sessionId))
      .then((sync) => {
        if (sync) this.applySyncPayload(sync)
        return sync
      })
      .catch(() => null)
      .finally(() => {
        this._syncPromise = null
      })
    return this._syncPromise
  },

  applySyncPayload(sync) {
    if (!sync || !this.data.sessionId) return
    sync = api.normalizeSyncContext(sync)
    if (sync.traceId) this.applyServerTraceId(sync.traceId)
    const profileChanged = this.checkTripProfileChangeFromSync(sync)
    this.syncIntakePhaseFromSync(sync, { skipMarkDone: profileChanged })
    const patch = {}
    if (sync.status) patch.status = sync.status
    if (sync.updatedAtMs) patch.updatedAt = sync.updatedAtMs
    if (sync.planningPhase) patch.planningPhase = sync.planningPhase
    if (sync.degraded != null) patch.degraded = !!sync.degraded
    const recovery = api.buildRecoveryFromSync(sync)
    if (recovery) patch.recovery = recovery
    if (sync.intakeProgress) {
      patch.intakeProgress = sync.intakeProgress
    }
    if (sync.planSteps) {
      patch.planSteps = sync.planSteps
    }
    if (sync.preferences) {
      patch.preferences = { ...(sessionStore.getSession(this.data.sessionId) || {}).preferences, ...sync.preferences }
    }
    const intakePhaseOver = this.shouldEnterPlanningFromSync(sync)
    if (intakePhaseOver) {
      patch.intakeProgress = null
      if (recovery) recovery.intakeProgress = null
    }
    sessionStore.touchSession(this.data.sessionId, patch)
    if (sync.planningPhase) {
      this.setData({ planningPhase: sync.planningPhase })
    }
    if (sync.degraded != null) {
      this.applyDegradedState(!!sync.degraded)
    }
    if (sync.preferences && !profileChanged) {
      this.setData({ preferences: patch.preferences })
    }
    const intakeProgress = intakePhaseOver
      ? null
      : (sync.intakeProgress || (recovery && recovery.intakeProgress))
    if (intakeProgress && tripProfileUtil.isIntakeProgressComplete(intakeProgress) && !profileChanged) {
      this.markIntakePhaseDone('sync_progress')
    } else {
      this.applyIntakeProgress(
        intakeProgress,
        this.data.preferences,
        { serverOnly: !!intakeProgress }
      )
    }
    this.applyPlanSteps(sync.planSteps || (recovery && recovery.planSteps))
    if (this._skipSyncAsk) return
    if (this.data.awaitingReply && this.hasPendingIntakeQuestionInView()) return
    if (sync.hasQuestion && sync.question && !this.isStaleIntakeQuestion(sync)) {
      if (!this.canPresentIntakeQuestion({ fromRecovery: true, sync })) {
        logger.log('intake', `sync 追问被规划阶段门禁拦截 sessionId=${this.data.sessionId}`)
        if (this._intakePhaseDone && !this.data.planComplete) {
          this.scheduleFinishCheck()
        }
        return
      }
      const latest = String(sync.question).trim()
      if (latest === this.getLastIntakeQuestion() && this.hasPendingIntakeQuestionInView()) {
        this.activatePendingIntakeQuestion({
          options: sync.options || [],
          questionId: sync.questionId || '',
          questionCategory: sync.questionCategory || ''
        })
        return
      }
      if (latest !== this.getLastIntakeQuestion() || !this.data.awaitingReply) {
        this.presentIntakeQuestion(sync.question, {
          options: sync.options || [],
          questionId: sync.questionId || '',
          questionCategory: sync.questionCategory || '',
          sync
        })
      }
    }
  },

  openSessionTab(sessionId, createTabIfNeeded, options) {
    options = options || {}
    const fromSidebarTabSwitch = !!options.fromSidebarTabSwitch
    let session = sessionStore.getSession(sessionId)
    if (!session) {
      sessionStore.loadSessionDetail(sessionId).then((detail) => {
        if (detail) {
          this.openSessionTab(sessionId, createTabIfNeeded)
        } else {
          this.sanitizeOpenTabs()
          wx.showToast({ title: '会话不存在', icon: 'none' })
          this.setData({
            sessionId: '',
            openTabs: sessionStore.getOpenTabs(sessionStore.loadStore())
          })
          wx.redirectTo({ url: '/pages/index/index' })
        }
      })
      return
    }

    if (createTabIfNeeded !== false) {
      const res = sessionStore.addOpenTab(sessionId)
      if (!res.ok && res.reason === 'max_tabs') {
        wx.showToast({ title: sessionStore.MAX_SESSIONS_HINT, icon: 'none' })
        return
      }
    } else {
      sessionStore.setActiveSession(sessionId)
    }

    this.pauseActiveRuntime()
    sessionStore.setActiveSession(sessionId)

    const isRemote = !session.local && !String(sessionId).startsWith('sess_local_')
    if (isRemote) {
      const cachedMsgs = session.chat && session.chat.messages
      const hasCachedView = fromSidebarTabSwitch
        && this._isPageActive
        && cachedMsgs && cachedMsgs.length > 0
      if (hasCachedView) {
        this.applySessionToView(session)
      } else {
        this.setData({
          sessionId,
          userId: session.userId || getApp().getUserId() || '',
          query: session.query || '',
          emptyState: false,
          sessionLoading: true
        })
        this.refreshShellUI()
      }
      sessionStore.loadSessionDetail(sessionId).then((detail) => {
        if (this.data.sessionId && this.data.sessionId !== sessionId) return
        try {
          if (detail) {
            const viewMsgs = this.data.messages || []
            const inFlight = !!(this._requestTask || this.data.isThinking || this._planRefreshing)
            if (inFlight && viewMsgs.length > 0) {
              sessionStore.touchSession(sessionId, {
                recovery: detail.recovery,
                intakeProgress: detail.intakeProgress,
                status: detail.status,
                planResult: detail.planResult,
                traceId: detail.traceId,
                msgPagination: detail.msgPagination
              })
            } else {
              this.applySessionToView(detail)
            }
          } else if (!hasCachedView) {
            sessionStore.removeOpenTab(sessionId)
            this.sanitizeOpenTabs()
            wx.showToast({ title: '会话不存在', icon: 'none' })
          }
        } catch (e) {
          logger.log('session', `openSessionTab apply failed: ${(e && e.message) || e}`)
          if (detail && detail.chat) {
            this.setData({
              sessionId: detail.sessionId,
              messages: sessionMessages.normalizeUiMessages(detail.chat.messages || []),
              sessionLoading: false,
              emptyState: false
            })
          }
        } finally {
          this.setData({ sessionLoading: false })
        }
      }).catch((e) => {
        logger.log('session', `loadSessionDetail failed: ${(e && e.message) || e}`)
        this.setData({ sessionLoading: false })
      })
      return
    }

    this.applySessionToView(session)
  },

  createSessionFromPayload(payload) {
    if (!sessionStore.canCreateSession()) {
      wx.showToast({ title: sessionStore.MAX_SESSIONS_HINT, icon: 'none' })
      return
    }
    sessionStore.createSession({
      query: payload.query,
      destination: payload.destination,
      days: payload.days,
      preferences: payload.preferences
    }).then((session) => {
      const tabRes = sessionStore.addOpenTab(session.sessionId)
      if (!tabRes.ok && tabRes.reason === 'max_tabs') {
        wx.showToast({ title: sessionStore.MAX_SESSIONS_HINT, icon: 'none' })
        return
      }
      this.pauseActiveRuntime()
      this.applySessionToView(session, { skipRecovery: true })
      this.startPlanning(session.query, session.preferences, getApp().getUserId(), { incremental: false })
    })
  },

  onToggleSidebar() {
    this.setData({ sidebarOpen: !this.data.sidebarOpen })
    if (this.data.sidebarOpen) {
      this.refreshSidebarList()
    }
  },

  onGoToPlan() {
    this.flushPersistActiveSession()
    this.pauseActiveRuntime()
    this.setData({ sidebarOpen: false })
    wx.redirectTo({ url: '/pages/index/index' })
  },

  onCloseSidebar() {
    this.setData({ sidebarOpen: false })
  },

  onEmptyOpenSidebar() {
    this.setData({ sidebarOpen: true })
    this.refreshSidebarList()
  },

  tryNavigateNewPlanning() {
    if (!sessionStore.canCreateSession()) {
      wx.showToast({ title: sessionStore.MAX_SESSIONS_HINT, icon: 'none' })
      return false
    }
    wx.navigateTo({ url: '/pages/index/index' })
    return true
  },

  async onSwitchTab(e) {
    const sessionId = e.currentTarget.dataset.id
    if (!sessionId || sessionId === this.data.sessionId) return
    this.flushPersistActiveSession()
    await this.openSessionTab(sessionId, false, { fromSidebarTabSwitch: true })
  },

  onCloseTab(e) {
    const sessionId = e.currentTarget.dataset.id
    wx.showModal({
      title: '关闭会话',
      content: '关闭后可在历史对话中重新打开',
      success: async (res) => {
        if (!res.confirm) return
        if (sessionId === this.data.sessionId) this.pauseActiveRuntime()
        sessionStore.removeOpenTab(sessionId)
        const store = sessionStore.loadStore()
        if (store.activeSessionId) {
          await this.openSessionTab(store.activeSessionId, false, { fromSidebarTabSwitch: true })
        } else {
          wx.redirectTo({ url: '/pages/index/index' })
        }
        this.refreshShellUI()
      }
    })
  },

  async onSidebarSelect(e) {
    const { sessionId } = e.detail
    this.setData({ sidebarOpen: false })
    const inTab = this.data.openTabs.some((t) => t.sessionId === sessionId)
    if (inTab) {
      this.flushPersistActiveSession()
      await this.openSessionTab(sessionId, false, { fromSidebarTabSwitch: true })
    } else {
      await this.openSessionTab(sessionId, true)
    }
  },

  async onSidebarSearch(e) {
    const list = await sessionStore.fetchHistory(e.detail.keyword)
    this.setData({ historyList: list })
  },

  onSidebarLongPress(e) {
    this.confirmDeleteSession(e.detail.sessionId)
  },

  onSidebarDelete(e) {
    this.confirmDeleteSession(e.detail.sessionId)
  },

  confirmDeleteSession(sessionId) {
    wx.showModal({
      title: '删除规划',
      content: '删除后无法恢复，确定继续吗？',
      confirmColor: '#c2410c',
      success: (res) => {
        if (!res.confirm) return
        this.removeSessionById(sessionId)
      }
    })
  },

  savePlanningState(status) {
    const { userId, query, preferences, sessionId } = this.data
    if (sessionId) {
      sessionStore.touchSession(sessionId, { status, userId, query, preferences })
    }
    wx.setStorageSync(PLANNING_STATE_KEY, {
      sessionId,
      userId,
      query,
      preferences,
      status,
      updatedAt: Date.now()
    })
  },

  startPlanning(query, preferences, userId, options = {}) {
    let {
      incremental = true,
      refresh = false,
      retry = false,
      resume = false,
      redesign = false
    } = options
    const session = this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null
    if (!refresh && !redesign && !options.replanIntent && !options.afterIntakeAnswer
      && this.isWaitingForUserAnswer(session)) {
      logger.log('planning', `跳过 POST /plan：等待 user-input sessionId=${this.data.sessionId}`)
      this.syncFromServer()
      return
    }
    if (!redesign && !options.replanIntent && this.data.planStepLimitReached) {
      const hint = this.data.planStepsHint || '本会话规划次数已达上限'
      logger.log('planning', `跳过 POST /plan：planSteps 上限 sessionId=${this.data.sessionId}`)
      wx.showToast({ title: hint.length > 28 ? hint.slice(0, 28) + '…' : hint, icon: 'none' })
      return
    }
    const intakeIncomplete = !refresh && !redesign && !options.replanIntent && this.isIntakeIncomplete(session)
    if (intakeIncomplete) {
      resume = true
      incremental = false
      if ((this.data.messages || []).length > 0 && !refresh) {
        retry = true
      }
      logger.log(
        'planning',
        `INTAKE 未完成，强制 resume=true incremental=false retry=${retry} sessionId=${this.data.sessionId}`
      )
    }
    this._streamIncremental = incremental
    this._isRedesign = !!redesign || !!options.replanIntent
    if (refresh || redesign || options.replanIntent) {
      this._isPlanUpdate = (incremental || !!options.durationChange) && !redesign && !options.replanIntent
    } else if (!retry && !resume) {
      this._isPlanUpdate = false
      this._isRedesign = false
    }
    const streamFlags = { incremental, resume: !!resume, redesign: !!redesign }

    if (this._requestTask && !refresh && !retry) {
      logger.log('planning', `跳过重复 startPlanning sessionId=${this.data.sessionId}`)
      return
    }

    if (this._requestTask && this._requestTask.abort) {
      this._requestTask.abort()
      this._requestTask = null
    }
    this.stopPolling()
    this.stopFinishCheck()

    const onMeta = (meta) => {
      const traceId = (meta && (meta.traceId || meta.trace_id)) || ''
      if (traceId) {
        this.applyServerTraceId(traceId)
        logger.log('planning', `收到 meta traceId=${traceId}`)
      }
      const phaseMsg = meta && meta.resumePhase ? `从 ${meta.resumePhase} 阶段继续…` : ''
      if (phaseMsg) {
        this.appendPhaseStep({ phase: 'resume', message: phaseMsg })
      }
    }
    const onPhase = (phase) => {
      this.appendPhaseStep(phase)
    }

    if (refresh) {
      this._planRefreshing = true
      this._streamEnded = false
      this._streamHttpDone = false
      this._renderingPlan = false
      this._askPollStopped = false
      this.stripInProgressPlanShell()
      this._streamBuffer = ''
      this.setData({
        planComplete: false,
        postPlanChat: false,
        awaitingReply: false,
        summary: '',
        days: [],
        inputPlaceholder: '输入消息...',
        isThinking: false,
        showInterruptBanner: false
      })
      wx.setStorageSync(PLANNING_STATE_KEY, {
        userId,
        query,
        preferences: preferences || {},
        status: 'planning',
        updatedAt: Date.now()
      })
      this.showThinking(redesign ? '正在重新规划行程...' : '正在根据您的反馈调整行程...')
      this.clearIntakeProgressUi()
      if (this._intakePhaseDone) {
        this.startPlanningWatchdog()
      }
      this.startStream(query, preferences, userId, { onMeta, onPhase, onError: (err) => this.handleStreamError(err) }, { ...streamFlags, refresh: true })
      return
    }

    if (retry) {
      this._streamEnded = false
      this._streamHttpDone = false
      this._renderingPlan = false
      this._askPollStopped = false
      if (intakeIncomplete) {
        const cleaned = stripIntakeInterruptedPlanMessages(this.data.messages || [])
        this.setData({
          messages: cleaned,
          summary: '',
          days: [],
          planComplete: false,
          postPlanChat: false
        })
      }
      this.setData({
        showInterruptBanner: false,
        showOverlay: false,
        isThinking: false
      })
      this.savePlanningState('planning')
      this.showThinking('正在重新连接...')
      this.startStream(query, preferences, userId, { onMeta, onPhase, onError: (err) => this.handleStreamError(err) }, streamFlags)
      return
    }

    this._msgSeq = 0
    this._streamEnded = false
    this._streamHttpDone = false
    this._renderingPlan = false
    this._askPollStopped = false
    this._streamBuffer = ''
    this._intakePhaseDone = false
    this._tripProfileFingerprint = ''
    this._planWatchdogFired = false
    this.stopPlanningWatchdog()
    this.setData({
      messages: [],
      scrollTo: '',
      inputValue: '',
      inputFocus: false,
      inputPlaceholder: '输入消息...',
      awaitingReply: false,
      planComplete: false,
      postPlanChat: false,
      isThinking: false,
      showOverlay: false,
      showInterruptBanner: false,
      userId,
      query,
      preferences: preferences || {},
      traceId: '',
      summary: '',
      days: []
    })
    wx.setStorageSync(PLANNING_STATE_KEY, {
      userId,
      query,
      preferences: preferences || {},
      status: 'planning',
      updatedAt: Date.now()
    })
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, { status: 'planning', userId, query, preferences })
    }
    this.pushMessage({ role: 'user', type: 'text', content: query })
    this.applyIntakeProgress(null, preferences || {})
    this.showThinking('正在连接规划服务...')
    this.startStream(query, preferences, userId, { onMeta, onPhase, onError: (err) => this.handleStreamError(err) }, streamFlags)
  },

  handleStreamError(err) {
    if (err && err.statusCode === 409) {
      this.handlePlanAlreadyRunning()
      return
    }
    if (err && err.statusCode === 422) {
      if (this.isPlanStepLimitError(err)) {
        this.handlePlanStepLimitReached(err)
        return
      }
      this.syncFromServer().then((sync) => {
        if (sync && sync.planSteps && sync.planSteps.limitReached) {
          this.handlePlanStepLimitReached(err, sync)
          return
        }
        this.handlePlanWaitingAnswer()
      })
      return
    }
    this.handleStreamInterrupted()
  },

  handlePlanWaitingAnswer() {
    this.clearReconnectTimer()
    this._reconnectAttempt = 0
    this._streamHttpDone = true
    this._streamEnded = false
    this.removeThinking()
    this.setData({ showInterruptBanner: false, showOverlay: false, isThinking: false })
    logger.log('planning', `POST /plan 422 waiting_answer，同步会话 sessionId=${this.data.sessionId}`)
    this.syncFromServer().then((sync) => {
      if (!this.data.awaitingReply && sync && sync.hasQuestion && sync.question) {
        this.maybeAskInChat(sync.question, {
          options: sync.options || [],
          questionId: sync.questionId || '',
          questionCategory: sync.questionCategory || '',
          sync
        })
      } else if (!this.data.awaitingReply && !this._askPollStopped) {
        this.startPolling()
      }
    })
  },

  handlePlanStepLimitReached(err, sync) {
    this.clearReconnectTimer()
    this._reconnectAttempt = 0
    this._streamHttpDone = true
    this._streamEnded = true
    this.removeThinking()
    this.stopPolling()
    this.stopFinishCheck()
    this.stopPlanningWatchdog()
    const planSteps = (sync && sync.planSteps) || this.data.planSteps
    const body = (err && err.body) || {}
    const hint = (planSteps && planSteps.hint)
      || body.message
      || body.error
      || '本会话规划次数已达上限，请新建会话继续。'
    this.applyPlanSteps(planSteps || {
      limitReached: true,
      limit: 20,
      hint
    })
    this.setData({ showInterruptBanner: false, showOverlay: false, isThinking: false })
    logger.log('planning', `POST /plan 422 planSteps 上限 sessionId=${this.data.sessionId}`)
    wx.showToast({ title: hint.length > 28 ? hint.slice(0, 28) + '…' : hint, icon: 'none', duration: 3500 })
  },

  handlePlanAlreadyRunning() {
    if (this._planSyncMode) {
      logger.log('planning', `已在轮询同步，忽略重复 409 sessionId=${this.data.sessionId}`)
      return
    }
    this._planSyncMode = true
    logger.log('planning', `后端已有进行中规划，跳过重复 POST /plan sessionId=${this.data.sessionId}`)
    this.clearReconnectTimer()
    this._reconnectAttempt = 0
    this._streamHttpDone = true
    this._streamEnded = false
    this.removeThinking()
    this.setData({ showInterruptBanner: false, interruptBannerText: '' })
    this.showThinking('规划进行中，正在同步进度...')
    this.savePlanningState('planning')
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, { status: 'planning' })
    }
    if (!this._intakePhaseDone) {
      this.markIntakePhaseDone('plan_409')
    } else if (!this.data.planComplete) {
      this.startPlanningWatchdog()
    }
    if (!this._askPollStopped && !this.data.awaitingReply) {
      this.startPolling()
      this.scheduleFinishCheck()
    }
  },

  handleStreamInterrupted() {
    if (this._streamHttpDone) {
      logger.log('planning', 'HTTP 流已正常结束，忽略迟到的中断回调')
      return
    }
    // askUser 等待回答时 SSE 可能长时间无数据或被客户端误判断开，后端仍在等 user-input
    if (this.data.awaitingReply) {
      logger.log('planning', `SSE 断开但待用户回答，不展示中断条 sessionId=${this.data.sessionId}`)
      this._streamHttpDone = true
      if (!this._askPollStopped) {
        this.resetPollIdleTimer()
      }
      return
    }
    this._streamEnded = true
    this.stopPolling()
    this.stopFinishCheck()
    this.removeThinking()
    this.savePlanningState('interrupted')
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, { status: 'interrupted' })
    }
    this.setData({ showOverlay: false, showInterruptBanner: true })
    this.refreshShellUI()
    logger.log('planning', `流中断 sessionId=${this.data.sessionId}`)
    this.scheduleReconnect()
  },

  clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this._reconnectCountdownTimer) {
      clearInterval(this._reconnectCountdownTimer)
      this._reconnectCountdownTimer = null
    }
  },

  getReconnectDelay(attempt) {
    return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt))
  },

  scheduleReconnect() {
    this.clearReconnectTimer()
    if (this.data.awaitingReply || this._streamHttpDone || this.data.planComplete) return
    if (this._reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.setData({
        interruptBannerText: '网络连接中断，已达最大重试次数，点击重试'
      })
      return
    }

    const delay = this.getReconnectDelay(this._reconnectAttempt)
    let remainSec = Math.ceil(delay / 1000)
    const updateBanner = () => {
      this.setData({
        interruptBannerText: `网络连接中断，${remainSec}秒后自动重连（点击立即重试）`
      })
    }
    updateBanner()

    this._reconnectCountdownTimer = setInterval(() => {
      remainSec -= 1
      if (remainSec <= 0) return
      updateBanner()
    }, 1000)

    this._reconnectTimer = setTimeout(() => {
      this.clearReconnectTimer()
      if (this._streamHttpDone || this.data.awaitingReply || this.data.planComplete) return
      this.attemptReconnect()
    }, delay)
  },

  attemptReconnect() {
    const session = sessionStore.getSession(this.data.sessionId)
    if (this.data.planStepLimitReached) {
      this.setData({ showInterruptBanner: false, interruptBannerText: '' })
      return
    }
    if (this.isWaitingForUserAnswer(session)) {
      logger.log('planning', `重连跳过 POST /plan，等待 user-input sessionId=${this.data.sessionId}`)
      this.setData({ showInterruptBanner: false, interruptBannerText: '' })
      this.syncFromServer()
      return
    }
    const { query, preferences, userId } = this.data
    this._reconnectAttempt += 1
    logger.log('planning', `自动重连第 ${this._reconnectAttempt} 次 sessionId=${this.data.sessionId}`)
    this.setData({ showInterruptBanner: false, interruptBannerText: '' })
    this.startPlanning(query, preferences, userId, this.resolveResumePlanOptions())
  },

  onRetry() {
    this.clearReconnectTimer()
    this._reconnectAttempt = 0
    const session = sessionStore.getSession(this.data.sessionId)
    if (this.data.planStepLimitReached) {
      this.setData({ showInterruptBanner: false, interruptBannerText: '' })
      return
    }
    if (this.isWaitingForUserAnswer(session)) {
      logger.log('planning', `重试跳过 POST /plan，等待 user-input sessionId=${this.data.sessionId}`)
      this.setData({ showInterruptBanner: false, interruptBannerText: '' })
      this.syncFromServer()
      return
    }
    const { query, preferences, userId } = this.data
    this.setData({ showInterruptBanner: false, interruptBannerText: '' })
    this.startPlanning(query, preferences, userId, this.resolveResumePlanOptions())
  },

  buildPlanIntroText() {
    if (this._isRedesign) return '已为你重新规划，完整行程如下：'
    if (this._isPlanUpdate) return '已根据你的反馈更新了行程：'
    return '为你规划好了，完整行程如下：'
  },

  buildPlanFooterText() {
    const base = '如果你对行程满意可以直接参考；想调整细节或重新规划，回复告诉我就好。'
    if (this.data.planDegraded || this._planDegraded) {
      return (this.data.degradedHint || '规划超时，当前为部分结果，建议核对后使用。') + '\n' + base
    }
    return base
  },

  buildPlanMessageBatch(summary, days, options) {
    options = options || {}
    const includeFooter = options.includeFooter !== false
    const hasRenderablePlan = hasRenderableContent({ summary, days })
    const batch = []
    const pushBatch = (msg) => {
      batch.push({ id: this.nextMsgId(), planBlock: true, ...msg })
    }
    if (!hasRenderablePlan) {
      pushBatch({
        role: 'assistant',
        type: 'text',
        content: '行程还在生成中，暂未解析到详细内容，请稍候…'
      })
      return { batch, hasRenderablePlan }
    }
    pushBatch({
      role: 'assistant',
      type: 'route',
      content: this.buildPlanIntroText(),
      summary,
      days,
      footer: includeFooter ? this.buildPlanFooterText() : ''
    })
    return { batch, hasRenderablePlan }
  },

  applyPlanMessages(batch, summary, days, hasRenderablePlan, options) {
    options = options || {}
    if (hasRenderablePlan && (this.isIntakeIncomplete() || this.isWaitingForUserAnswer())) {
      logger.log('planning', `intake 未完成，忽略 plan 渲染 sessionId=${this.data.sessionId}`)
      return
    }
    const base = options.replacePlan
      ? sessionStore.stripPlanBlocks(this.data.messages)
      : (this.data.messages || [])
    const messages = [...base, ...batch]
    const lastId = batch.length ? batch[batch.length - 1].id : ''
    const patch = {
      messages,
      scrollTo: lastId,
      summary,
      days,
      showOverlay: false,
      isThinking: false
    }
    if (hasRenderablePlan) {
      Object.assign(patch, {
        planComplete: true,
        postPlanChat: true,
        awaitingReply: false,
        inputPlaceholder: '继续提问，或要求调整方案…',
        showIntakeProgress: false,
        intakeProgressLabel: '',
        questionCategory: '',
        questionCategoryLabel: ''
      })
      this._intakeProgress = null
      this._intakeProgressFromServer = false
      this._planRefreshing = false
      this.stopPlanningWatchdog()
    }
    this.setData(patch)
    if (hasRenderablePlan) {
      sessionStore.touchSession(this.data.sessionId, {
        status: 'done',
        planResult: { summary, days },
        summaryPreview: (summary || '').slice(0, 50)
      })
      this.persistActiveSession()
      this.savePlanningState('done')
      this.startPolling()
      // 不再自动 POST /plan/narrate：天卡片 + summary 已是完整权威展示；
      // 模板 narrate 内容与 summary 高度重复，会造成「行程解读」二次插入。
      // 需要阅读稿时再显式调用 startNarrateStream()。
    }
    this.refreshShellUI()
  },

  /**
   * §18：展示轨 narrate（可选）。天卡片仍只读 plan/result。
   * 默认不在出方案后自动调用，避免与 route 卡片重复展示。
   */
  startNarrateStream() {
    const sessionId = this.data.sessionId
    if (!sessionId || !this._isPageActive) return
    this.stopNarrateStream()
    this._narrateParser = createTagPartitionParser()
    this._narrateRenderer = createThrottledRenderer({
      intervalMs: 80,
      onRender: (snap) => this.applyNarrateSnapshot(snap)
    })
    this.setData({
      narrateVisible: true,
      narrateStreaming: true,
      narrateThinkText: '',
      narrateHasThink: false,
      narrateHasContent: false,
      narrateHasReferences: false,
      narrateContentNodes: [],
      narrateReferencesNodes: [],
      scrollTo: 'narrate-panel'
    })
    this._narrateTask = createNarrateStreamRequest({
      data: { sessionId },
      silentHttpError: true,
      onMarkdown: (chunk) => this.feedNarrateChunk(chunk),
      onMeta: (meta) => {
        if (meta && (meta.traceId || meta.trace_id)) {
          this.applyServerTraceId(meta.traceId || meta.trace_id)
        }
      },
      onDone: () => this.finishNarrateStream(),
      onStreamError: (err) => {
        logger.log('narrate', `SSE error ${(err && err.message) || ''}`)
        this.finishNarrateStream()
      },
      onComplete: () => this.finishNarrateStream(),
      onError: (err) => {
        const code = err && err.statusCode
        logger.log('narrate', `不可用 status=${code || ''}（后端未上线则忽略）`)
        this.setData({
          narrateStreaming: false,
          narrateVisible: !!(this.data.narrateHasContent || this.data.narrateHasThink)
        })
        this.stopNarrateStream({ keepUi: true })
      }
    })
  },

  feedNarrateChunk(chunk) {
    if (!this._narrateParser || !chunk) return
    const snap = this._narrateParser.feed(chunk)
    if (this._narrateRenderer) this._narrateRenderer.schedule(snap)
  },

  applyNarrateSnapshot(snap) {
    if (!snap || !this._isPageActive) return
    const vm = buildNarrateViewModel(snap)
    // 模板 think「正在整理行程阅读稿…」不是用户可读的思考过程，有正文后收起
    const thinkIsStatus = /正在(整理|生成)行程阅读稿/.test(vm.thinkText || '')
    const showThink = vm.hasThink && !(thinkIsStatus && vm.hasContent)
    this.setData({
      narrateThinkText: showThink ? vm.thinkText : '',
      narrateHasThink: showThink,
      narrateHasContent: vm.hasContent,
      narrateHasReferences: vm.hasReferences,
      narrateContentNodes: vm.contentNodes,
      narrateReferencesNodes: vm.referencesNodes,
      narrateVisible: !!(showThink || vm.hasContent || vm.hasReferences)
    })
  },

  finishNarrateStream() {
    if (this._narrateParser) {
      const snap = this._narrateParser.finish()
      if (this._narrateRenderer) this._narrateRenderer.flush(snap)
      else this.applyNarrateSnapshot(snap)
    }
    this.setData({ narrateStreaming: false })
    this._narrateTask = null
  },

  stopNarrateStream(options) {
    options = options || {}
    if (this._narrateTask && typeof this._narrateTask.abort === 'function') {
      try { this._narrateTask.abort() } catch (e) { /* ignore */ }
    }
    this._narrateTask = null
    if (this._narrateRenderer) {
      this._narrateRenderer.dispose()
      this._narrateRenderer = null
    }
    this._narrateParser = null
    if (!options.keepUi) {
      this.setData({
        narrateVisible: false,
        narrateStreaming: false,
        narrateThinkText: '',
        narrateHasThink: false,
        narrateHasContent: false,
        narrateHasReferences: false,
        narrateContentNodes: [],
        narrateReferencesNodes: []
      })
    }
  },

  schedulePlanRetry() {
    this._renderingPlan = false
    if (this.data.awaitingReply || this._planWatchdogFired) return
    this.stopFinishCheck()
    this._finishTimer = setTimeout(() => {
      if (this.data.awaitingReply || this.data.planComplete) return
      this.loadPlanResult()
    }, PLAN_RETRY_DELAY)
  },

  stripInProgressPlanShell() {
    const messages = this.data.messages.filter((m) => {
      if (m.type === 'thinking' || m.type === 'phase') return false
      const text = m.content || ''
      if (String(text).indexOf('暂未解析到详细内容') >= 0) return false
      if (String(text).indexOf('行程还在生成中') >= 0) return false
      return true
    })
    this.setData({ messages })
    this.persistActiveSession()
  },

  onShow() {
    this._isPageActive = true
    const activePlanning = this.data.isThinking || this._requestTask || this._planRefreshing
      || (this.data.status === 'planning' && !this.data.planComplete)
    if (!this._askPollStopped && this.data.sessionId && (this.data.awaitingReply || activePlanning)) {
      this.startPolling()
      this.resetPollIdleTimer()
    }
    if (this._intakePhaseDone && !this.data.planComplete) {
      this.startPlanningWatchdog()
    }
    if (this._skipShowRestore) {
      this._skipShowRestore = false
      return
    }
    const { sessionId } = this.data
    if (sessionId && !String(sessionId).startsWith('sess_local_')) {
      sessionStore.loadSessionDetail(sessionId).then((detail) => {
        if (!detail || this.data.sessionId !== sessionId) return
        this.applySessionToView(detail)
        return this.syncFromServer()
      }).then((sync) => {
        if (!sync) return
        const session = sessionStore.getSession(sessionId)
        if (session) this.applySessionRecovery(session)
      }).catch(() => {})
    }
  },

  onHide() {
    this._isPageActive = false
    this.stopPolling()
    this.stopFinishCheck()
    this.stopPlanningWatchdog()
    this.clearPollIdleTimer()
    this.flushPersistActiveSession()
  },

  onUnload() {
    this._isPageActive = false
    this.clearReconnectTimer()
    this.stopAskPollingPermanently()
    this.stopFinishCheck()
    this.clearPollIdleTimer()
    if (this._progressPlanTimer) {
      clearTimeout(this._progressPlanTimer)
      this._progressPlanTimer = null
    }
    this.stopNarrateStream()
    this.flushPersistActiveSession()
    if (this._requestTask && this._requestTask.abort) this._requestTask.abort()
    if (this._onNetworkChange) {
      wx.offNetworkStatusChange(this._onNetworkChange)
      this._onNetworkChange = null
    }
  },

  nextMsgId() {
    this._msgSeq += 1
    return 'msg_' + this._msgSeq
  },

  pushMessage(msg) {
    const item = { id: this.nextMsgId(), ...msg }
    const index = this.data.messages.length
    this.data.messages.push(item)
    const update = {}
    update[`messages[${index}]`] = item
    update.scrollTo = item.id
    this.setData(update)
    this.persistActiveSession()
    return item
  },

  replaceThinkingWithMessage(newMsg) {
    const filtered = this.data.messages.filter((m) => m.type !== 'thinking' && m.type !== 'phase')
    const item = { id: this.nextMsgId(), ...newMsg }
    filtered.push(item)
    this.setData({
      messages: filtered,
      scrollTo: item.id,
      isThinking: false
    })
    this.data.messages = filtered
    this.persistActiveSession()
    return item
  },

  appendMessageAsync(msg) {
    return new Promise((resolve) => {
      const item = { id: this.nextMsgId(), ...msg }
      const messages = [...this.data.messages, item]
      this.setData({ messages, scrollTo: item.id }, () => resolve(item))
    })
  },

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },

  scrollToMessage(msgId) {
    return new Promise((resolve) => {
      if (!msgId) {
        resolve()
        return
      }
      this.setData({ scrollTo: msgId }, () => {
        wx.pageScrollTo({ scrollTop: 99999, duration: 200 })
        setTimeout(resolve, 80)
      })
    })
  },

  removeThinking() {
    this.removeTransientMessages()
  },

  removeTransientMessages() {
    const messages = this.data.messages.filter(
      (m) => m.type !== 'thinking' && m.type !== 'phase'
    )
    this.setData({ messages, isThinking: false })
  },

  formatPhaseContent(phase) {
    if (!phase) return ''
    let content = String(phase.message || '').trim()
    if (phase.phase === 'intake' && this.data.intakeProgressLabel) {
      content = this.data.intakeProgressLabel + ' · ' + content
    }
    return content
  },

  appendPhaseStep(phase) {
    const phaseName = phase && phase.phase ? String(phase.phase).toLowerCase() : ''
    if (phaseName === 'research' || phaseName === 'planning' || phaseName === 'detail') {
      this.markIntakePhaseDone('phase_' + phaseName)
    }
    const content = this.formatPhaseContent(phase)
    if (!content) return
    const phaseKey = [phase.phase || '', phase.progress, phase.total, content].join('|')
    if (this._lastPhaseKey === phaseKey) return
    this._lastPhaseKey = phaseKey
    const newMessages = this.data.messages.filter(
      (m) => m.type !== 'thinking' && m.type !== 'phase'
    )
    const item = {
      id: this.nextMsgId(),
      role: 'assistant',
      type: 'phase',
      content,
      phase: phase.phase || '',
      progress: phase.progress,
      total: phase.total
    }
    newMessages.push(item)
    this.setData({
      messages: newMessages,
      scrollTo: item.id,
      isThinking: false
    })
    this.data.messages = newMessages
    this.persistActiveSession()
  },

  showThinking(content) {
    this.removeThinking()
    let label = content || '思考中...'
    if (!this._intakePhaseDone && this.data.showIntakeProgress && this.data.intakeProgressLabel) {
      label = this.data.intakeProgressLabel + ' · ' + label
    }
    // 进入规划整理态时清掉 INTAKE 快捷钮，避免「正在整理」与「没有了」并存
    if (this._intakePhaseDone || /整理最终行程|连接规划|重新规划|重新连接|同步进度/.test(label)) {
      this.clearAskReplyUi()
    }
    this.pushMessage({
      role: 'assistant',
      type: 'thinking',
      content: label
    })
    this.setData({ isThinking: true })
  },

  startStream(query, prefs, userId, streamHandlers, streamOptions = {}) {
    this._streamEnded = false
    this._streamHttpDone = false
    this._planSyncMode = false
    this._lastPhaseKey = ''
    this.clearReconnectTimer()
    this.stopNarrateStream()
    const incremental = streamOptions.incremental === true
    const resolvedUserId = userId || getApp().getUserId()

    const planData = {
      sessionId: this.data.sessionId,
      query,
      userId: resolvedUserId,
      preferences: prefs || {},
      incremental
    }
    if (streamOptions.resume) planData.resume = true
    if (streamOptions.redesign) planData.redesign = true
    if (streamOptions.refresh) planData.refresh = true

    this._requestTask = createStreamRequest({
      data: planData,
      onData: (chunk) => this.handleChunk(chunk),
      onMeta: streamHandlers && streamHandlers.onMeta,
      onPhase: streamHandlers && streamHandlers.onPhase,
      onDegraded: (payload) => this.handleStreamDegraded(payload),
      onStatusChange: () => {},
      onComplete: () => this.onStreamHttpComplete(),
      onError: (err) => {
        if (streamHandlers && streamHandlers.onError) {
          streamHandlers.onError(err)
          return
        }
        this.handleStreamError(err)
      }
    })

    if (!streamOptions.refresh) {
      this.startPolling()
    }
  },

  generateRequestId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16)
      const v = c === 'x' ? r : ((r & 0x3) | 0x8)
      return v.toString(16)
    })
  },

  startPolling() {
    if (this._askPollStopped || !this._isPageActive) return
    this.stopPolling()
    if (this.data.awaitingReply) return
    this.pollAskQuery()
    this._pollTimer = setInterval(() => {
      if (!this._askPollStopped && !this.data.awaitingReply && this._isPageActive) {
        this.pollAskQuery()
      }
    }, POLL_INTERVAL)
    if (this.data.postPlanChat) {
      this.resetPollIdleTimer()
    }
  },

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  },

  clearPollIdleTimer() {
    if (this._pollIdleTimer) {
      clearTimeout(this._pollIdleTimer)
      this._pollIdleTimer = null
    }
  },

  resetPollIdleTimer() {
    this.clearPollIdleTimer()
    if (this._askPollStopped) return
    if (this.data.awaitingReply) return
    if (!this.data.postPlanChat) return
    this._pollIdleTimer = setTimeout(() => {
      logger.log('ask-query', '用户30秒未应答，停止轮询')
      this.stopAskPollingPermanently()
    }, ASK_POLL_IDLE_TIMEOUT)
  },

  stopAskPollingPermanently() {
    this._askPollStopped = true
    this.stopPolling()
    this.clearPollIdleTimer()
  },

  onUserAskPollActivity() {
    if (this._askPollStopped) return
    this.clearPollIdleTimer()
    if (this.data.awaitingReply || this.data.postPlanChat) {
      this.resetPollIdleTimer()
    }
  },

  stopFinishCheck() {
    if (this._finishTimer) {
      clearTimeout(this._finishTimer)
      this._finishTimer = null
    }
  },

  parseAskPayload(resData) {
    if (!resData) {
      return {
        hasQuestion: false, question: '', options: [], questionId: '', traceId: '', questionCategory: ''
      }
    }
    const payload = resData.data !== undefined ? resData.data : resData
    const question = (
      payload.question || payload.content || payload.message || payload.prompt || ''
    ).trim()
    let hasQuestion = (
      payload.hasQuestion === true
      || payload.hasQuestion === 1
      || payload.hasQuestion === 'true'
    )
    if (!hasQuestion && question && payload.hasQuestion !== false) {
      hasQuestion = true
    }
    const options = Array.isArray(payload.options) ? payload.options.filter(Boolean) : []
    const questionId = payload.questionId || ''
    const traceId = payload.traceId || ''
    const questionCategory = payload.questionCategory || ''
    if (payload.intakeProgress) {
      this.applyIntakeProgress(payload.intakeProgress, this.data.preferences, { serverOnly: true })
    }
    return { hasQuestion, question, options, questionId, traceId, questionCategory }
  },

  pollAskQuery() {
    if (!this._isPageActive || this._askPollStopped || this._planRefreshing || (!this.data.userId && !this.data.sessionId) || this.data.awaitingReply) return
    const { userId, sessionId } = this.data

    const query = {}
    if (sessionId) query.sessionId = sessionId
    if (userId) query.userId = userId

    wx.request({
      url: api.resolveUrl('/ask-query'),
      method: 'GET',
      data: query,
      header: api.buildHeaders(),
      success: (res) => {
        if (this._askPollStopped || this.data.awaitingReply || !this._isPageActive) return
        if (res.statusCode === 404 || res.statusCode === 410 || res.statusCode === 403) {
          logger.log('ask-query', `session gone status=${res.statusCode}, stop polling sessionId=${sessionId}`)
          this.stopAskPollingPermanently()
          return
        }
        if (res.statusCode !== 200 || !res.data) return
        logger.log('ask-query', `sessionId=${sessionId}, status=${res.statusCode}, hasQuestion=${!!(res.data && res.data.hasQuestion)}`)
        const parsed = this.parseAskPayload(res.data)
        if (parsed.traceId) {
          this.applyServerTraceId(parsed.traceId)
        }
        if (parsed.hasQuestion && parsed.question) {
          const askMeta = {
            liveQuestion: true,
            options: parsed.options,
            questionId: parsed.questionId,
            questionCategory: parsed.questionCategory
          }
          if (!this.canPresentIntakeQuestion(askMeta)) {
            logger.log('intake', `ask-query 追问被规划阶段门禁拦截 sessionId=${sessionId}`)
            if (this._intakePhaseDone && !this.data.planComplete) {
              this.scheduleFinishCheck()
            }
            return
          }
          this.stopPolling()
          const q = String(parsed.question).trim()
          if (q === this.getLastIntakeQuestion() && this.hasPendingIntakeQuestionInView()) {
            this.activatePendingIntakeQuestion(askMeta)
          } else if (q !== this.getLastIntakeQuestion() || !this.data.awaitingReply) {
            this.presentIntakeQuestion(parsed.question, askMeta)
          } else if (canReopenIntakeForLiveQuestion({
            intakePhaseDone: this._intakePhaseDone,
            intakeIncomplete: this.isIntakeIncomplete(),
            planningPhase: this.data.planningPhase,
            planComplete: this.data.planComplete,
            postPlanChat: this.data.postPlanChat,
            isThinking: this.data.isThinking
          })) {
            this.setData({
              awaitingReply: true,
              inputPlaceholder: '请输入您的回答',
              askOptions: parsed.options || this.data.askOptions || [],
              questionCategory: parsed.questionCategory || '',
              questionCategoryLabel: tripProfileUtil.categoryLabel(parsed.questionCategory)
            })
          } else {
            this.clearAskReplyUi()
          }
          return
        }
        if (this.isIntakeIncomplete() && !this.data.postPlanChat) {
          if (this._requestTask && !this._streamHttpDone) return
          if (this.data.awaitingReply || this._intakeResolving || this.hasPendingIntakeQuestionInView()) return
          if (!this._isPageActive) return
          this.stopPolling()
          this.removeThinking()
          this.ensureIntakeQuestion()
        }
      },
      fail: () => {
        if (!this._isPageActive) return
      }
    })
  },

  presentIntakeQuestion(question, meta) {
    meta = meta || {}
    if (!question) return
    if (!this.canPresentIntakeQuestion(meta)) {
      logger.log('intake', `规划阶段忽略追问 sessionId=${this.data.sessionId}`)
      if (this._intakePhaseDone && !this.data.planComplete) {
        this.scheduleFinishCheck()
      }
      return
    }
    if (this.shouldSkipIntakeQuestion({ ...meta, question })) {
      if (meta.fromRecovery) {
        this.continueIntakeAfterAnswer(null)
      }
      return
    }
    const q = String(question).trim()
    if (this.hasPendingIntakeQuestionInView() && q === this.getLastIntakeQuestion()) {
      this.activatePendingIntakeQuestion(meta)
      return
    }
    this.askInChat(question, meta)
  },

  askInChat(question, meta) {
    meta = meta || {}
    if (meta.forceAsk) {
      this._intakePhaseDone = false
      this.stopPlanningWatchdog()
    }
    this.stopPolling()
    let messages = (this.data.messages || []).filter((m) => m.type !== 'thinking' && m.type !== 'phase')
    if (!this.data.postPlanChat) {
      messages = sessionMessages.prepareIntakeDialog(messages, { legacyCollapse: false })
    }
    const item = { id: this.nextMsgId(), role: 'assistant', type: 'text', content: question }
    messages.push(item)
    this._pendingQuestionId = meta.questionId || ''
    this._pendingQuestionCategory = meta.questionCategory || ''
    if (meta.traceId) {
      this.applyServerTraceId(meta.traceId)
    }
    let options = Array.isArray(meta.options) ? meta.options.filter(Boolean) : []
    if (!options.length && meta.questionCategory) {
      options = tripProfileUtil.defaultOptionsForCategory(meta.questionCategory)
    }
    if (this.data.sessionId) {
      sessionStore.touchSession(this.data.sessionId, {
        status: 'waiting_answer',
        chat: {
          ...(sessionStore.getSession(this.data.sessionId) || {}).chat,
          awaitingReply: true,
          messages
        }
      })
    }
    this.setData({
      messages,
      scrollTo: item.id,
      isThinking: false,
      awaitingReply: true,
      askOptions: options,
      questionCategory: meta.questionCategory || '',
      questionCategoryLabel: tripProfileUtil.categoryLabel(meta.questionCategory),
      inputPlaceholder: '请输入您的回答',
      inputFocus: false
    }, () => {
      this.setData({ inputFocus: true })
    })
    this.data.messages = messages
    this.persistActiveSession()
  },

  async sendAnswer(text) {
    const { userId, sessionId } = this.data
    const requestId = this.generateRequestId()
    const wasPlanComplete = this.data.planComplete
    const confirmed = isItineraryConfirmation(text)

    this.onUserAskPollActivity()
    if (confirmed && (wasPlanComplete || this.data.postPlanChat)) {
      this.stopAskPollingPermanently()
    } else if (!confirmed) {
      this._askPollStopped = false
    }

    const questionId = this._pendingQuestionId || ''
    const answeredCategory = this._pendingQuestionCategory || this.data.questionCategory || ''
    this._lastAnsweredQuestionId = questionId
    this._pendingQuestionId = ''
    this._pendingQuestionCategory = ''
    this.setData({
      inputValue: '',
      inputFocus: false,
      awaitingReply: false,
      askOptions: [],
      questionCategory: '',
      questionCategoryLabel: '',
      inputPlaceholder: this.data.postPlanChat ? '继续提问，或要求调整方案…' : '输入消息...'
    })

    let traceId = this.data.traceId
    if (!traceId && sessionId) {
      traceId = await this.syncTraceIdFromServer()
    }

    const onSubmitSuccess = () => {
      this.setData({ showInterruptBanner: false })
      this.pushMessage({ role: 'user', type: 'text', content: text })
      logger.log('user-input', `已提交 userId=${userId}, requestId=${requestId}, traceId=${this.data.traceId || ''}, questionId=${questionId || ''}`)
      if (isReplanConfirmMeta({ questionCategory: answeredCategory })) {
        this.syncFromServer().then((sync) => {
          if (/重新规划/.test(text)) {
            this.reopenIntakeForProfileChange()
            this._intakePhaseDone = false
            this.startPlanning(this.data.query, this.data.preferences, userId, {
              incremental: false,
              redesign: true
            })
          } else if (sync && (sync.status === 'done' || resolvePlanningPhase(sync) === 'done')) {
            this.markIntakePhaseDone('replan_keep', { skipWatchdog: true })
            this.loadPlanResult({ forceFinalize: true })
          }
        })
        return
      }
      if (wasPlanComplete) {
        this.setData({ showOverlay: true, scrollTo: 'plan-overlay' })
        const { query, preferences } = this.data
        this.startPlanning(query, preferences, userId, { incremental: true, refresh: true })
        return
      }
      if (isSupplementConfirmedAnswer(text, answeredCategory)) {
        this.markIntakePhaseDone('supplement_answer')
      }
      this._skipSyncAsk = true
      const intakeStreamActive = this.isIntakeIncomplete() && this._requestTask && !this._streamHttpDone
      if (!intakeStreamActive) {
        this.clearStaleIntakeWaitingState()
        this._streamHttpDone = true
        this._requestTask = null
      }
      this.showThinking('正在理解您的回答…')
      if (!this._askPollStopped && this.isIntakeIncomplete()) {
        this.startPolling()
      }
      this.syncFromServer().then((sync) => {
        this._skipSyncAsk = false
        if (!this._askPollStopped) {
          this.continueIntakeAfterAnswer(sync, questionId)
        }
      }).catch(() => {
        this._skipSyncAsk = false
      })
      if (this._streamHttpDone && !this.data.planComplete && !this.isIntakeIncomplete()) {
        this.scheduleFinishCheck()
      }
    }

    const submit = (tid, silent) => api.userInput({
      sessionId, userId, answer: text, traceId: tid, requestId, questionId
    }, { silent })

    try {
      await submit(traceId, false)
      onSubmitSuccess()
    } catch (err) {
      const body = (err && err.body) || {}
      const isTraceMismatch = (err && err.statusCode === 422)
        && (body.currentTraceId || /traceId.*不匹配/.test((err && err.message) || ''))
      if (isTraceMismatch) {
        const newTraceId = body.currentTraceId || await this.syncTraceIdFromServer()
        if (newTraceId && newTraceId !== traceId) {
          try {
            await submit(newTraceId, true)
            onSubmitSuccess()
            return
          } catch (retryErr) {
            err = retryErr
          }
        }
      }
      wx.showToast({ title: (err && err.message) || '发送失败', icon: 'none' })
      this._pendingQuestionId = questionId
      this.setData({ awaitingReply: true, inputValue: text, inputPlaceholder: '请输入您的回答' })
    }
  },

  onStreamHttpComplete() {
    this._requestTask = null
    this._streamHttpDone = true
    this.clearReconnectTimer()
    this._reconnectAttempt = 0
    if (this._progressPlanTimer) {
      clearTimeout(this._progressPlanTimer)
      this._progressPlanTimer = null
    }
    logger.log('stream', `HTTP 流结束 userId=${this.data.userId}, bufferLen=${(this._streamBuffer || '').length}`)
    this.setData({ showInterruptBanner: false, interruptBannerText: '' })
    const fromBuffer = this.resolvePlanFromBuffer()
    if (fromBuffer && hasRenderableContent(fromBuffer)) {
      this.showPlanInChat(fromBuffer)
      return
    }
    if (this.isIntakeIncomplete()) {
      this.removeThinking()
      this.stopPolling()
      if (this.data.awaitingReply || this.hasPendingIntakeQuestionInView()) return
      this.syncFromServer().then((sync) => {
        if (this.data.awaitingReply || this.hasPendingIntakeQuestionInView()) return
        if (sync && sync.hasQuestion && sync.question && this.canPresentIntakeQuestion({ fromRecovery: true, sync })) {
          if (this.isStaleIntakeQuestion(sync)) {
            this.activatePendingIntakeQuestion({
              options: sync.options || [],
              questionId: sync.questionId || '',
              questionCategory: sync.questionCategory || ''
            })
            return
          }
          this.presentIntakeQuestion(sync.question, {
            options: sync.options || [],
            questionId: sync.questionId || '',
            questionCategory: sync.questionCategory || '',
            sync
          })
          return
        }
        if (this.shouldEnterPlanningFromSync(sync)) {
          if (!this._intakePhaseDone) this.markIntakePhaseDone('stream_sync')
          this.showThinking('正在整理最终行程...')
          this.scheduleFinishCheck()
          if (!this._askPollStopped) this.startPolling()
          return
        }
        if (!this._askPollStopped) this.startPolling()
      })
      return
    }
    this.showThinking('正在整理最终行程...')
    this.scheduleFinishCheck()
    if (!this._askPollStopped) {
      this.startPolling()
    }
  },

  scheduleFinishCheck() {
    if (this.isIntakeIncomplete() || this.isWaitingForUserAnswer()) return
    this.stopFinishCheck()
    this._finishTimer = setTimeout(() => {
      if (this.data.awaitingReply || this._streamEnded || this.data.planComplete) return
      if (!this._askPollStopped) {
        this.pollAskQuery()
      }
      this._finishTimer = setTimeout(() => {
        if (this.data.awaitingReply || this._streamEnded || this.data.planComplete) return
        this.tryFinalizePlanning()
      }, 1500)
    }, 2000)
  },

  tryFinalizePlanning() {
    if (this._planRefreshing || this.data.awaitingReply || this._streamEnded || this.data.planComplete) return
    if (this.isIntakeIncomplete() || this.isWaitingForUserAnswer()) return
    if (this._askPollStopped) {
      this.loadPlanResult()
      return
    }
    const { userId, sessionId } = this.data
    const query = {}
    if (sessionId) query.sessionId = sessionId
    if (userId) query.userId = userId

    wx.request({
      url: api.resolveUrl('/ask-query'),
      method: 'GET',
      data: query,
      header: api.buildHeaders(),
      success: (res) => {
        if (this.data.awaitingReply || this._streamEnded || this.data.planComplete) return
        if (res.statusCode === 200 && res.data) {
          const parsed = this.parseAskPayload(res.data)
          if (parsed.traceId) {
            this.applyServerTraceId(parsed.traceId)
          }
          if (parsed.hasQuestion && parsed.question) {
            this.maybeAskInChat(parsed.question, {
              options: parsed.options,
              questionId: parsed.questionId,
              questionCategory: parsed.questionCategory
            })
            return
          }
        }
        this.loadPlanResult()
      },
      fail: () => {
        this.loadPlanResult()
      }
    })
  },

  handleChunk(chunk) {
    if (!chunk) return
    const askIdx = chunk.indexOf('[EVENT:ASK]')
    if (askIdx >= 0) {
      if (askIdx > 0) this.appendBuffer(chunk.slice(0, askIdx))
      const jsonPart = chunk.slice(askIdx + '[EVENT:ASK]'.length)
      try {
        const end = jsonPart.indexOf('}')
        if (end >= 0) {
          const eventData = JSON.parse(jsonPart.slice(0, end + 1))
          this.presentIntakeQuestion(eventData.question || '请补充你的偏好', {
            questionId: eventData.questionId,
            traceId: eventData.traceId
          })
          const rest = jsonPart.slice(end + 1)
          if (rest) this.appendBuffer(rest)
        }
      } catch (e) { /* skip */ }
      return
    }
    this.appendBuffer(chunk)
  },

  appendBuffer(text) {
    if (!text) return
    this._streamBuffer += text
    this.scheduleProgressivePlanRender()
  },

  scheduleProgressivePlanRender() {
    if (this._progressPlanTimer) return
    this._progressPlanTimer = setTimeout(() => {
      this._progressPlanTimer = null
      this.tryProgressivePlanRender()
    }, 200)
  },

  tryProgressivePlanRender() {
    if (!this._isPageActive || this._streamEnded || this._streamHttpDone || this.data.planComplete) return
    if (this._renderingPlan || this.isIntakeIncomplete()) return
    const plan = normalizePlan(this._streamBuffer || '')
    const days = (plan.days || []).filter(hasRenderableDay)
    const summary = (plan.summary || '').trim()
    if (!days.length) return
    this.applyStreamingPlanPreview(summary, days)
  },

  /**
   * 流式增量：只更新天卡片，不挂 footer，不算 planComplete。
   */
  applyStreamingPlanPreview(summary, days) {
    const prevLen = (this.data.days && this.data.days.length) || 0
    if (days.length < prevLen) return
    if (days.length === prevLen && summary === (this.data.summary || '')) return

    let messages = (this.data.messages || []).filter(
      (m) => m.type !== 'thinking' && m.type !== 'phase'
    )
    let routeIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'route' && messages[i].planBlock) {
        routeIdx = i
        break
      }
    }
    const routeMsg = {
      id: routeIdx >= 0 ? messages[routeIdx].id : this.nextMsgId(),
      role: 'assistant',
      type: 'route',
      planBlock: true,
      streaming: true,
      content: this.buildPlanIntroText(),
      summary: summary || this.data.summary || '',
      days,
      footer: ''
    }
    if (routeIdx >= 0) messages[routeIdx] = routeMsg
    else messages.push(routeMsg)

    const tipId = this.nextMsgId()
    messages.push({
      id: tipId,
      role: 'assistant',
      type: 'thinking',
      content: '正在生成后续行程…'
    })
    this.setData({
      messages,
      summary: routeMsg.summary,
      days,
      scrollTo: tipId,
      isThinking: true,
      planComplete: false,
      postPlanChat: false,
      inputPlaceholder: '行程生成中…'
    })
    this.data.messages = messages
  },

  resolvePlanFromBuffer() {
    const buffer = this._streamBuffer || ''
    logger.logPlanResponse(this.data.userId, buffer)
    const plan = normalizePlan(buffer)
    if (hasRenderableContent(plan)) {
      logger.log('parse', `从流 buffer 解析成功 userId=${this.data.userId}, days=${plan.days.length}, summaryLen=${plan.summary.length}`)
      return plan
    }
    logger.log('parse', `流 buffer 解析失败 userId=${this.data.userId}, bufferLen=${buffer.length}`)
    return null
  },

  extractDonePlan(res) {
    const extracted = extractPlanFromResponse(res)
    if (extracted.ready) {
      return { summary: extracted.summary, days: extracted.days }
    }
    return null
  },

  loadPlanResult(options) {
    options = options || {}
    const forceFinalize = !!options.forceFinalize
    if (this._renderingPlan) return
    // 流仍在灌：禁止用半截 buffer finalize（否则 summary-only 会提前挂 footer）
    if (!forceFinalize && !this._streamHttpDone) {
      logger.log('plan/result', `流未结束，跳过提前 finalize sessionId=${this.data.sessionId}`)
      return
    }
    if (this.isIntakeIncomplete() || this.isWaitingForUserAnswer()) {
      logger.log('plan/result', `intake 未完成，跳过拉取 sessionId=${this.data.sessionId}`)
      return
    }
    if (this._streamEnded && this.data.planComplete && !this.data.showOverlay) return

    const fromBuffer = this.resolvePlanFromBuffer()
    if (fromBuffer && hasRenderableContent(fromBuffer)) {
      this.showPlanInChat(fromBuffer)
      return
    }

    const { userId, traceId, sessionId } = this.data
    logger.log('plan/result', `拉取结果 sessionId=${sessionId}, userId=${userId}, traceId=${traceId || ''}, force=${forceFinalize}`)

    const fetchPromise = api.getResult(sessionId || userId, traceId).then((res) => {
      logger.log('plan/result', `响应 userId=${userId}, body=${JSON.stringify(res).slice(0, 500)}`)
      const extracted = extractPlanFromResponse(res)
      if (extracted.ready) {
        return { summary: extracted.summary, days: extracted.days }
      }
      if (extracted.status === 'done' && extracted.ready === false) {
        const err = new Error(extracted.message || 'parse_failed')
        err.parseFailed = true
        throw err
      }
      if (extracted.status === 'planning') {
        throw new Error('not_ready')
      }
      throw new Error('status not done')
    })

    const fetchTimeout = forceFinalize ? 15000 : RESULT_FETCH_TIMEOUT
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), fetchTimeout)
    })

    Promise.race([fetchPromise, timeoutPromise])
      .then((plan) => this.showPlanInChat(plan))
      .catch((err) => {
        logger.log('plan/result', `失败或超时 userId=${userId}, err=${(err && err.message) || 'unknown'}`)
        const fromBufferRetry = this.resolvePlanFromBuffer()
        if (fromBufferRetry && hasRenderableContent(fromBufferRetry)) {
          this.setData({ showOverlay: false })
          this.showPlanInChat(fromBufferRetry)
          return
        }
        this.setData({ showOverlay: false })
        if (forceFinalize || this._planWatchdogFired) {
          this.applyPlanningFallbackFinish(err)
          return
        }
        if (err && err.parseFailed) {
          this.removeThinking()
          this.stopPolling()
          this.stopFinishCheck()
          wx.showToast({ title: '行程解析失败', icon: 'none' })
          return
        }
        if (!this.data.planComplete) {
          this.schedulePlanRetry()
        }
      })
  },

  showPlanInChat(planResult) {
    if (this._renderingPlan) return
    if (this.isIntakeIncomplete() || this.isWaitingForUserAnswer()) {
      logger.log('planning', `跳过 showPlanInChat：intake 未完成 sessionId=${this.data.sessionId}`)
      return
    }
    const { summary, days } = normalizePlan(planResult || {})
    const hasRenderablePlan = hasRenderableContent({ summary, days })
    const isRefresh = this._isPlanUpdate || this.data.showOverlay

    if (this.data.planComplete && !isRefresh && !this.data.showOverlay && this.hasPlanContent(this.data.messages)) {
      return
    }
    if (!hasRenderablePlan) {
      if (this.data.planComplete && this.hasPlanContent(this.data.messages)) {
        return
      }
      if (sessionStore.hasEmptyPlanShell(this.data.messages)) {
        this._renderingPlan = false
        this.schedulePlanRetry()
        return
      }
      if (!this._streamHttpDone && !this._planSyncMode) {
        return
      }
    }

    this._renderingPlan = true
    this.stopPlanningWatchdog()
    this.stopPolling()
    this.stopFinishCheck()
    this.removeTransientMessages()
    logger.logParseResult(this.data.userId, JSON.stringify(planResult).slice(0, 200), days, summary)

    const app = getApp()
    if (hasRenderablePlan) {
      app.globalData.planResult = { summary, days }
      app.globalData.streamingText = planToPlainText({ summary, days })
      app.globalData.query = this.data.query
      app.globalData.preferences = this.data.preferences || {}
    }

    if (sessionStore.hasEmptyPlanShell(this.data.messages)) {
      this.stripInProgressPlanShell()
    }

    const { batch, hasRenderablePlan: ready } = this.buildPlanMessageBatch(summary, days, {
      includeFooter: true
    })
    if (!ready) {
      this.applyPlanMessages(batch, summary, days, false)
      this._renderingPlan = false
      this._streamEnded = false
      this.showThinking('正在整理最终行程...')
      this.schedulePlanRetry()
      return
    }

    if (this._progressPlanTimer) {
      clearTimeout(this._progressPlanTimer)
      this._progressPlanTimer = null
    }
    this._streamEnded = true
    if (this._planDegraded) {
      this.applyDegradedState(true)
    }
    this.setData({ planningPhase: 'done' })
    this.applyPlanMessages(batch, summary, days, true, { replacePlan: true })
    this._renderingPlan = false
  },

  onTapAskOption(e) {
    const text = e.currentTarget.dataset.text
    if (!text || !this.data.awaitingReply) return
    this.sendAnswer(text)
  },

  onInputChange(e) {
    this.setData({ inputValue: e.detail.value })
  },

  onSendMessage() {
    const text = (this.data.inputValue || '').trim()
    if (!text) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }

    if (this.isIntakeNeedsContinuation()) {
      this.sendAnswer(text)
      return
    }

    if (this.data.awaitingReply) {
      this.sendAnswer(text)
      return
    }

    if (this.data.postPlanChat) {
      this._askPollStopped = false
      this.startPolling()
      this.onUserAskPollActivity()
      if (isItineraryConfirmation(text)) {
        this.stopAskPollingPermanently()
        this.pushMessage({ role: 'user', type: 'text', content: text })
        this.setData({ inputValue: '', inputFocus: false })
        this.pushMessage({
          role: 'assistant',
          type: 'text',
          content: '好的，祝你旅途愉快！如需调整随时告诉我。'
        })
        return
      }
      this.pushMessage({ role: 'user', type: 'text', content: text })
      this.setData({ inputValue: '', inputFocus: false })
      const isRedesign = /重新规划|重新生成|再来一次|换一个|不满意|重做|再来/.test(text)
      this.pushMessage({
        role: 'assistant',
        type: 'text',
        content: isRedesign ? '好的，我来为你重新规划行程。' : '好的，正在根据你的反馈调整行程…'
      })
      this.handlePostPlanMessage(text)
      return
    }

    if (this.data.planComplete) return

    const session = this.data.sessionId ? sessionStore.getSession(this.data.sessionId) : null
    if (this.isWaitingForUserAnswer(session)) {
      this.sendAnswer(text)
      return
    }
    if (this.isIntakeIncomplete(session)) {
      const submitIntakeAnswer = () => this.sendAnswer(text)
      const resumeIntakePlan = () => {
        this.pushMessage({ role: 'user', type: 'text', content: text })
        this.setData({ inputValue: '', inputFocus: false, query: text })
        if (this.data.sessionId) {
          sessionStore.touchSession(this.data.sessionId, { query: text })
        }
        const { preferences, userId } = this.data
        this.startPlanning(text, preferences, userId, {
          incremental: false,
          resume: true,
          retry: true
        })
      }
      if ((this.data.messages || []).length > 0) {
        this.syncFromServer().then((sync) => {
          if (this.syncPayloadWaitingAnswer(sync) || this.isWaitingForUserAnswer()) {
            submitIntakeAnswer()
          } else {
            resumeIntakePlan()
          }
        })
        return
      }
      resumeIntakePlan()
    }
  },

  handlePostPlanMessage(text) {
    if (this.data.planAdjustDisabled || this.data.planStepLimitReached) {
      wx.showToast({
        title: (this.data.planStepsHint || '已达规划次数上限').slice(0, 28),
        icon: 'none'
      })
      return
    }
    const { preferences, userId, sessionId } = this.data
    this.setData({ query: text })
    if (/重新规划|重新生成|再来一次|换一个|不满意|重做|再来/.test(text)) {
      const replanQuery = `请完全重新规划行程，不要沿用上一版草稿。${text}`
      this.startPlanning(replanQuery, preferences, userId, {
        incremental: false,
        refresh: true,
        redesign: false,
        replanIntent: true
      })
      return
    }
    const duration = parseDurationFromText(text)
    const durationChange = isDurationChangeRequest(text) && duration && duration.days > 0
    let planQuery = text
    if (durationChange) {
      planQuery = buildDurationChangeQuery(text, duration)
      if (sessionId) {
        sessionStore.touchSession(sessionId, { query: text, days: duration.days })
      }
    }
    this.startPlanning(planQuery, preferences, userId, {
      incremental: !durationChange,
      refresh: true,
      durationChange
    })
  }
})

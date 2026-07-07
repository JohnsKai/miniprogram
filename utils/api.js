/**
 * 统一 API 请求与认证
 */

const PROD_BASE_URL = 'https://api.example.com'
const DEFAULT_DEV_LAN_HOST = 'localhost'

let _loginPromise = null

function getAppInstance() {
  return getApp()
}

function isDevLogging() {
  try {
    const app = getAppInstance()
    if (!app || !app.globalData) return false
    if (app.globalData.ENV !== 'dev') return false
    return app.globalData.debugLog !== false
  } catch (e) {
    return false
  }
}

function devLog(...args) {
  if (isDevLogging()) console.log(...args)
}

function getServicePort() {
  const app = getAppInstance()
  const port = app && app.globalData && app.globalData.DEV_SERVICE_PORT
  return port || 8081
}

function getBaseUrl() {
  const app = getAppInstance()
  if (!app || !app.globalData) {
    return `http://${DEFAULT_DEV_LAN_HOST}:${getServicePort()}`
  }
  const { ENV, DEV_LAN_HOST } = app.globalData
  if (ENV === 'dev') {
    const host = DEV_LAN_HOST || DEFAULT_DEV_LAN_HOST
    return `http://${host}:${getServicePort()}`
  }
  return PROD_BASE_URL
}

function getToken() {
  const app = getAppInstance()
  return app ? app.getToken() : wx.getStorageSync('token') || ''
}

function buildHeaders(extraHeaders) {
  const headers = {
    'Content-Type': 'application/json',
    ...(extraHeaders || {})
  }
  const token = getToken()
  if (token) {
    headers.Authorization = 'Bearer ' + token
  }
  return headers
}

function resolveUrl(url) {
  if (url.startsWith('http')) return url
  return getBaseUrl() + url
}

/**
 * 通用请求封装
 */
function request(options) {
  const { url, method = 'GET', data, header, skipAuth = false, timeout = 8000, silent = false } = options
  const fullUrl = resolveUrl(url)

  return new Promise((resolve, reject) => {
    const headers = skipAuth
      ? { 'Content-Type': 'application/json', ...(header || {}) }
      : buildHeaders(header)

    devLog(`[api] ${method} ${fullUrl}`)

    wx.request({
      url: fullUrl,
      method,
      data,
      header: headers,
      timeout,
      success(res) {
        if (res.statusCode === 401) {
          refreshToken()
            .then(() => request(options).then(resolve).catch(reject))
            .catch(reject)
          return
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          const body = res.data || {}
          const msg = body.message || body.error || '请求失败'
          if (!silent) {
            wx.showToast({ title: msg, icon: 'none' })
          }
          const err = new Error(msg)
          err.statusCode = res.statusCode
          err.body = body
          reject(err)
        }
      },
      fail(err) {
        if (!silent) {
          wx.showToast({ title: '网络异常', icon: 'none' })
        }
        reject(err)
      }
    })
  })
}

function extractTraceId(detail) {
  if (!detail) return ''
  return detail.traceId
    || (detail.recovery && detail.recovery.lastTraceId)
    || ''
}

function resolvePlanningPhase(ctx) {
  if (!ctx) return ''
  return String(ctx.planningPhase || ctx.phase || '').toLowerCase()
}

function normalizeSyncContext(sync) {
  if (!sync) return sync
  const planningPhase = resolvePlanningPhase(sync)
  return {
    ...sync,
    planningPhase: planningPhase || sync.planningPhase || '',
    phase: planningPhase || sync.phase || ''
  }
}

function isReplanConfirmMeta(meta) {
  if (!meta) return false
  const cat = meta.questionCategory || meta.category || ''
  const q = String(meta.question || '').trim()
  return cat === 'other' && /重新规划|出行偏好/.test(q)
}

function buildRecoveryFromSync(sync) {
  if (!sync) return null
  const normalized = normalizeSyncContext(sync)
  const recovery = {
    suggestedAction: normalized.suggestedAction || '',
    lastTraceId: normalized.traceId || '',
    planningPhase: normalized.planningPhase || '',
    degraded: !!normalized.degraded
  }
  if (normalized.intakeProgress) {
    recovery.intakeProgress = normalized.intakeProgress
  }
  if (normalized.hasQuestion) {
    recovery.pendingQuestion = {
      question: normalized.question || '',
      options: normalized.options || [],
      questionId: normalized.questionId || '',
      questionCategory: normalized.questionCategory || ''
    }
    if (!recovery.suggestedAction) {
      recovery.suggestedAction = 'answer_question'
    }
  }
  if (normalized.planSteps) {
    recovery.planSteps = normalized.planSteps
  }
  if (normalized.planningPhase) {
    recovery.phase = normalized.planningPhase
  } else if (normalized.phase) {
    recovery.phase = normalized.phase
  }
  return recovery
}

function isPlanStepLimitMessage(message) {
  const msg = String(message || '')
  return /规划次数已达上限|重新规划次数已达上限|规划步数|步数.*上限|plan_step/i.test(msg)
}

/**
 * wx.login 换取 token
 */
function login() {
  if (_loginPromise) return _loginPromise

  _loginPromise = new Promise((resolve, reject) => {
    wx.login({
      success(loginRes) {
        if (!loginRes.code) {
          wx.showToast({ title: '登录失败', icon: 'none' })
          reject(new Error('no code'))
          return
        }
        request({
          url: '/auth/login',
          method: 'POST',
          data: { code: loginRes.code },
          skipAuth: true
        })
          .then((data) => {
            const token = data.token || data.accessToken || ''
            if (!token) {
              wx.showToast({ title: '登录失败', icon: 'none' })
              reject(new Error('no token'))
              return
            }
            const app = getAppInstance()
            app.setToken(token)
            app.setUserAuth({
              openId: data.openId || '',
              userId: data.userId || data.openId || ''
            })
            resolve(token)
          })
          .catch(reject)
          .finally(() => {
            _loginPromise = null
          })
      },
      fail(err) {
        _loginPromise = null
        wx.showToast({ title: '登录失败', icon: 'none' })
        reject(err)
      }
    })
  })

  return _loginPromise
}

function refreshToken() {
  const app = getAppInstance()
  if (app) {
    app.setToken('')
    app.setUserAuth({ openId: '', userId: '' })
  }
  return login()
}

function ensureLogin() {
  const token = getToken()
  if (token) return Promise.resolve(token)
  return login()
}

/**
 * 流式规划（返回 requestTask，由 stream.js 调用）
 */
function planStream(data) {
  return {
    url: resolveUrl('/plan'),
    data,
    header: buildHeaders()
  }
}

const api = {
  getBaseUrl,
  getToken,
  buildHeaders,
  resolveUrl,
  request,
  login,
  refreshToken,
  ensureLogin,

  plan(data) {
    return planStream(data)
  },

  createSession(data) {
    return request({
      url: '/sessions',
      method: 'POST',
      data
    })
  },

  listSessions(params) {
    return request({
      url: '/sessions',
      method: 'GET',
      data: params || {}
    })
  },

  getSession(sessionId) {
    return request({
      url: `/sessions/${sessionId}`,
      method: 'GET'
    })
  },

  syncSession(sessionId) {
    return request({
      url: `/sessions/${sessionId}/sync`,
      method: 'GET',
      silent: true
    }).catch(() => request({
      url: `/sessions/${sessionId}`,
      method: 'GET',
      silent: true
    }))
  },

  extractTraceId,
  resolvePlanningPhase,
  normalizeSyncContext,
  isReplanConfirmMeta,
  buildRecoveryFromSync,
  isPlanStepLimitMessage,

  patchSession(sessionId, data) {
    return request({
      url: `/sessions/${sessionId}`,
      method: 'PATCH',
      data
    })
  },

  deleteSession(sessionId) {
    return request({
      url: `/sessions/${sessionId}`,
      method: 'DELETE'
    })
  },

  askQuery(params) {
    return request({
      url: '/ask-query',
      method: 'GET',
      data: params
    })
  },

  userInput(data, options) {
    return request({
      url: '/user-input',
      method: 'POST',
      data,
      silent: !!(options && options.silent)
    })
  },

  getResult(sessionIdOrUserId, traceId) {
    const data = {}
    if (sessionIdOrUserId && String(sessionIdOrUserId).startsWith('sess_')) {
      data.sessionId = sessionIdOrUserId
    } else {
      data.userId = sessionIdOrUserId
    }
    if (traceId) data.traceId = traceId
    return request({
      url: '/plan/result',
      method: 'GET',
      data
    })
  },

  getProfile() {
    return request({ url: '/users/me', method: 'GET' })
  },

  listFavorites() {
    return request({ url: '/favorites', method: 'GET' })
  },

  createFavorite(data) {
    return request({ url: '/favorites', method: 'POST', data })
  },

  deleteFavorite(id) {
    return request({ url: `/favorites/${id}`, method: 'DELETE' })
  },

  getSessionMessages(sessionId, options) {
    let format = 'ui'
    let page = 0
    let size = 50
    let beforeCreatedAt
    let beforeMessageId
    if (typeof options === 'string') {
      format = options
    } else if (options && typeof options === 'object') {
      format = options.format || 'ui'
      if (options.page != null) page = options.page
      if (options.size != null) size = options.size
      if (options.beforeCreatedAt != null) beforeCreatedAt = options.beforeCreatedAt
      if (options.beforeMessageId) beforeMessageId = options.beforeMessageId
    }
    const data = { format, page, size }
    if (beforeCreatedAt != null && beforeMessageId) {
      data.beforeCreatedAt = beforeCreatedAt
      data.beforeMessageId = beforeMessageId
    }
    return request({
      url: `/sessions/${sessionId}/messages`,
      method: 'GET',
      data
    })
  }
}

module.exports = api

/**
 * 流式请求封装（真机 iOS/Android 兼容）
 * enableChunked + responseType:text + onChunkReceived
 */

const api = require('./api')
const logger = require('./logger')

/**
 * ArrayBuffer -> UTF-8 字符串（兼容真机）
 */
function decodeChunk(arrayBuffer) {
  if (!arrayBuffer) return ''
  const uint8 = new Uint8Array(arrayBuffer)
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8').decode(uint8)
    } catch (e) { /* fallback */ }
  }
  let str = ''
  for (let i = 0; i < uint8.length; i++) {
    str += String.fromCharCode(uint8[i])
  }
  try {
    return decodeURIComponent(escape(str))
  } catch (e) {
    return str
  }
}

/**
 * 从 DeepSeek / OpenAI 兼容 SSE JSON 中提取文本片段
 * 示例: data: {"choices":[{"delta":{"content":"你好\\n"}}]}
 */
function extractStreamContent(raw) {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return raw
  }

  try {
    const obj = JSON.parse(trimmed)
    const choice = obj.choices && obj.choices[0]
    if (choice) {
      if (choice.delta && choice.delta.content != null) {
        return String(choice.delta.content).replace(/\\n/g, '\n')
      }
      if (choice.message && choice.message.content != null) {
        return String(choice.message.content).replace(/\\n/g, '\n')
      }
      if (choice.text != null) {
        return String(choice.text).replace(/\\n/g, '\n')
      }
    }
    if (obj.content != null) return String(obj.content).replace(/\\n/g, '\n')
    if (obj.text != null) return String(obj.text).replace(/\\n/g, '\n')
    if (typeof obj.data === 'string') return obj.data.replace(/\\n/g, '\n')
    // 服务端标准行程 JSON（非 OpenAI delta 格式）
    if (obj.summary != null || Array.isArray(obj.days)) return trimmed
    if (obj.data && typeof obj.data === 'object' && (obj.data.summary != null || Array.isArray(obj.data.days))) {
      return trimmed
    }
    return ''
  } catch (e) {
    return raw
  }
}

/**
 * 解析 SSE 格式 chunk，去除 data: 前缀后逐段回调
 * 兼容 plain text SSE、DeepSeek JSON SSE 与 event: meta / phase / degraded
 * §18：event: markdown（展示正文 Raw，禁止再 JSON.parse）/ done / error
 */
function createSSEParser(handlers) {
  const onData = typeof handlers === 'function' ? handlers : handlers.onData
  const onMeta = typeof handlers === 'function' ? null : handlers.onMeta
  const onPhase = typeof handlers === 'function' ? null : handlers.onPhase
  const onDegraded = typeof handlers === 'function' ? null : handlers.onDegraded
  const onMarkdown = typeof handlers === 'function' ? null : handlers.onMarkdown
  const onDone = typeof handlers === 'function' ? null : handlers.onDone
  const onStreamError = typeof handlers === 'function' ? null : handlers.onStreamError
  const presentationMode = !!(typeof handlers === 'object' && handlers && handlers.presentationMode)
  let lineBuffer = ''
  let currentEvent = ''

  function resetEvent() {
    currentEvent = ''
  }

  function emitMeta(payload) {
    if (!payload || !onMeta) return
    try {
      const meta = JSON.parse(payload)
      onMeta(meta)
    } catch (e) {
      onMeta({ traceId: payload })
    }
  }

  function emitPhase(payload) {
    if (!payload || !onPhase) return
    try {
      onPhase(JSON.parse(payload))
    } catch (e) {
      onPhase({ message: payload })
    }
  }

  function emitDegraded(payload) {
    if (!payload || !onDegraded) return
    try {
      onDegraded(JSON.parse(payload))
    } catch (e) {
      onDegraded({ reason: payload })
    }
  }

  function emitMarkdownRaw(payload) {
    if (payload == null || payload === '[DONE]') return
    // §18.4：展示正文禁止 JSON.parse；直接透传
    if (onMarkdown) onMarkdown(payload)
    else if (onData) onData(payload)
  }

  function emitDone(payload) {
    if (onDone) onDone(payload == null ? '' : payload)
  }

  function emitStreamError(payload) {
    if (!onStreamError) return
    let err = { message: String(payload || 'stream error') }
    try {
      const obj = JSON.parse(payload)
      if (obj && typeof obj === 'object') err = obj
    } catch (e) { /* use raw */ }
    onStreamError(err)
  }

  function emitDataLine(payload) {
    // event: done 允许空 data
    if (currentEvent === 'done') {
      emitDone(payload == null ? '' : payload)
      resetEvent()
      return
    }

    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') emitDone('')
      return
    }

    if (currentEvent === 'meta') {
      emitMeta(payload)
      resetEvent()
      return
    }

    if (currentEvent === 'phase') {
      emitPhase(payload)
      resetEvent()
      return
    }

    if (currentEvent === 'degraded') {
      emitDegraded(payload)
      resetEvent()
      return
    }

    if (currentEvent === 'markdown') {
      emitMarkdownRaw(payload)
      resetEvent()
      return
    }

    if (currentEvent === 'error') {
      emitStreamError(payload)
      resetEvent()
      return
    }

    // 展示通道（narrate）：default data 一律当 Raw 文本，禁止走 extractStreamContent
    if (presentationMode) {
      emitMarkdownRaw(payload)
      resetEvent()
      return
    }

    const trimmedPayload = payload.trim()
    if (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')) {
      try {
        const obj = JSON.parse(trimmedPayload)
        if (obj.event === 'meta') {
          if (onMeta) onMeta(obj)
          resetEvent()
          return
        }
      } catch (e) { /* fall through */ }
    }

    resetEvent()

    const content = extractStreamContent(payload)
    if (!content) return

    // 流式 token 禁止自动追加 \\n：会导致 JSON 字符串内出现未转义换行从而 parse 失败
    if (onData) onData(content)
  }

  function emitLine(line) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed) {
      resetEvent()
      return
    }

    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.slice(6).replace(/^\s/, '')
      return
    }

    let payload = trimmed
    if (trimmed.startsWith('data:')) {
      payload = trimmed.slice(5).replace(/^\s/, '')
    }
    emitDataLine(payload)
  }

  function feed(chunkStr) {
    if (!chunkStr) return
    const combined = lineBuffer + chunkStr
    const lines = combined.split('\n')
    lineBuffer = lines.pop() || ''
    lines.forEach(emitLine)
  }

  function flush() {
    if (lineBuffer) {
      emitLine(lineBuffer)
      lineBuffer = ''
    }
  }

  return { feed, flush }
}

/**
 * 创建流式 POST 请求
 * @param {object} opts
 * @param {boolean} [opts.presentationMode] §18 展示通道：data 不走 JSON 解包
 * @param {function} [opts.onMarkdown] event:markdown 或 presentation raw
 * @param {function} [opts.onDone] event:done
 * @param {function} [opts.onStreamError] event:error（SSE 业务错，非网络）
 * @param {boolean} [opts.silentHttpError] 失败不 toast（narrate 可选）
 */
function createStreamRequest(opts) {
  const {
    url,
    data,
    onData,
    onMeta,
    onPhase,
    onDegraded,
    onMarkdown,
    onDone,
    onStreamError,
    onStatusChange,
    onComplete,
    onError,
    presentationMode,
    silentHttpError
  } = opts || {}
  const planConfig = url
    ? { url: api.resolveUrl(url), data, header: api.buildHeaders() }
    : api.plan(data)
  const fullUrl = planConfig.url
  const header = planConfig.header
  const body = planConfig.data || data
  let chunkCount = 0
  let totalChars = 0
  let doneSignaled = false

  const wrappedOnData = (chunk) => {
    chunkCount += 1
    totalChars += (chunk || '').length
    if (onData) onData(chunk)
  }
  const wrappedOnMarkdown = (chunk) => {
    chunkCount += 1
    totalChars += (chunk || '').length
    if (onMarkdown) onMarkdown(chunk)
    else if (onData) onData(chunk)
  }
  const wrappedOnMeta = (meta) => {
    logger.log('stream', `meta event traceId=${(meta && (meta.traceId || meta.trace_id)) || ''}`)
    if (onMeta) onMeta(meta)
  }
  const wrappedOnPhase = (phase) => {
    const msg = (phase && (phase.message || phase.phase)) || ''
    logger.log('stream', `phase event ${msg}`)
    if (onPhase) onPhase(phase)
  }
  const wrappedOnDegraded = (payload) => {
    logger.log('stream', `degraded event reason=${(payload && payload.reason) || ''}`)
    if (onDegraded) onDegraded(payload)
  }
  const wrappedOnDone = (payload) => {
    doneSignaled = true
    logger.log('stream', 'done event')
    if (onDone) onDone(payload)
  }
  const wrappedOnStreamError = (payload) => {
    logger.log('stream', `error event message=${(payload && payload.message) || ''}`)
    if (onStreamError) onStreamError(payload)
  }
  const sseParserWrapped = createSSEParser({
    onData: wrappedOnData,
    onMeta: wrappedOnMeta,
    onPhase: wrappedOnPhase,
    onDegraded: wrappedOnDegraded,
    onMarkdown: wrappedOnMarkdown,
    onDone: wrappedOnDone,
    onStreamError: wrappedOnStreamError,
    presentationMode: !!presentationMode
  })

  if (onStatusChange) {
    onStatusChange('正在连接 AI 旅行师...')
  }

  logger.log('stream', `开始请求 ${fullUrl}, userId=${body.userId || ''}, presentation=${!!presentationMode}`)

  let settled = false

  const requestTask = wx.request({
    url: fullUrl,
    method: 'POST',
    data: body,
    enableChunked: true,
    responseType: 'text',
    header,
    success(res) {
      if (res.statusCode === 401) {
        api.refreshToken().then(() => {
          createStreamRequest(opts)
        }).catch(() => {
          if (onStatusChange) onStatusChange('连接失败')
          if (onError) onError(new Error('认证失败'))
        })
        return
      }
      if (settled) return
      if (res.statusCode === 200) {
        settled = true
        sseParserWrapped.flush()
        if (!doneSignaled && onDone) onDone('')
        logger.log('stream', `请求完成 userId=${body.userId || ''}, chunks=${chunkCount}, chars=${totalChars}`)
        if (onStatusChange) onStatusChange('规划完成')
        if (onComplete) onComplete()
      } else {
        settled = true
        logger.log('stream', `请求失败 status=${res.statusCode}, userId=${body.userId || ''}`)
        if (onStatusChange) onStatusChange('连接失败')
        const err = new Error('status ' + res.statusCode)
        err.statusCode = res.statusCode
        err.body = res.data || {}
        if (err.body.message || err.body.error) {
          err.message = err.body.message || err.body.error
        }
        // 409/422：由 planning 页处理，勿 toast 误导用户
        // narrate 404/未上线：silentHttpError 时不打扰
        if (!silentHttpError && res.statusCode !== 409 && res.statusCode !== 422) {
          wx.showToast({ title: '规划请求失败', icon: 'none' })
        }
        if (onError) onError(err)
      }
    },
    fail(err) {
      if (settled) {
        logger.log('stream', `忽略重复 fail（已成功结束）userId=${body.userId || ''}`)
        return
      }
      settled = true
      logger.log('stream', `网络失败 userId=${body.userId || ''}, err=${err && err.errMsg}`)
      if (onStatusChange) onStatusChange('连接失败')
      if (!silentHttpError) {
        wx.showToast({ title: '网络连接失败', icon: 'none' })
      }
      if (onError) onError(err)
    }
  })

  if (requestTask && typeof requestTask.onChunkReceived === 'function') {
    requestTask.onChunkReceived((res) => {
      const chunkStr = decodeChunk(res.data)
      sseParserWrapped.feed(chunkStr)
    })
  }

  return requestTask
}

/**
 * §18 F-92：POST /plan/narrate 展示流（presentationMode）
 * 后端未上线时调用方应 silent + 忽略 404
 */
function createNarrateStreamRequest(opts) {
  const data = (opts && opts.data) || {}
  return createStreamRequest(Object.assign({}, opts, {
    url: '/plan/narrate',
    data,
    presentationMode: true,
    silentHttpError: opts && opts.silentHttpError !== false
  }))
}

module.exports = {
  createStreamRequest,
  createNarrateStreamRequest,
  decodeChunk,
  createSSEParser,
  extractStreamContent
}

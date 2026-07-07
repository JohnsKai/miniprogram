/**
 * 小程序端调试日志（对齐服务端 plan 完成日志格式）
 */

const TAG = 'travel-planner'

function isEnabled() {
  try {
    const app = getApp()
    if (app && app.globalData) {
      if (app.globalData.ENV !== 'dev') return false
      if (app.globalData.debugLog === false) return false
    }
  } catch (e) { /* ignore */ }
  return true
}

function timestamp() {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function preview(text, maxLen) {
  const max = maxLen || 400
  if (!text) return ''
  const s = String(text).replace(/\r/g, '').trim()
  if (s.length <= max) return s
  return s.slice(0, max) + '...(truncated)'
}

function log(tag, message, extra) {
  if (!isEnabled()) return
  const line = `[${timestamp()}] [${TAG}/${tag}] ${message}`
  if (extra !== undefined) {
    console.log(line, extra)
  } else {
    console.log(line)
  }
}

/** 对齐服务端：plan 完成 userId=xxx, 响应长度=xxx, 响应预览=... */
function logPlanResponse(userId, text) {
  const body = text || ''
  log('plan', `plan 完成 userId=${userId}, 响应长度=${body.length}, 响应预览=${preview(body, 400)}`)
}

function logParseResult(userId, rawPreview, days, summary) {
  log('parse', `userId=${userId}, days=${days ? days.length : 0}, summaryLen=${(summary || '').length}`)
  if (rawPreview) {
    log('parse', `  rawPreview=${String(rawPreview).slice(0, 200)}`)
  }
  if (days && days.length) {
    days.forEach((d) => {
      log('parse', `  Day ${d.day}: activities=${(d.activities || []).length}, meals=${(d.meals || []).length}`)
    })
  }
}

module.exports = {
  log,
  logPlanResponse,
  logParseResult,
  preview
}

/**
 * 服务端标准 JSON 行程解析与归一化
 * {
 *   "summary": "行程概要",
 *   "days": [{ day, date, weather, activities, meals, hotel }]
 * }
 */

function formatWalkingDistance(val) {
  if (val == null || val === '') return ''
  if (typeof val === 'number') {
    if (val >= 1000) {
      const km = val / 1000
      return (km % 1 === 0 ? km : km.toFixed(1).replace(/\.0$/, '')) + 'km'
    }
    return val + 'm'
  }
  return String(val)
}

function normalizeActivity(item) {
  if (!item) return null
  const desc = (item.description || item.desc || '').trim()
  if (!desc) return null

  const loc = item.location
  let lat = item.lat || item.latitude || null
  let lng = item.lng || item.longitude || null
  let locationName = ''

  if (typeof loc === 'string' && loc) {
    locationName = loc
  } else if (loc && typeof loc === 'object') {
    locationName = loc.name || loc.address || ''
    lat = lat || loc.latitude || loc.lat || null
    lng = lng || loc.longitude || loc.lng || null
  }

  return {
    time: item.time || '',
    type: item.type || '景点',
    desc,
    locationName,
    walkingDistance: formatWalkingDistance(item.walkingDistance != null ? item.walkingDistance : item.distance),
    lat,
    lng
  }
}

function normalizeMeal(item) {
  if (!item || !item.name) return null
  return {
    type: item.type || '餐饮',
    name: item.name,
    rating: Number(item.rating) || 0,
    comment: item.comment || ''
  }
}

function normalizeHotel(item) {
  if (!item || !item.name) return null
  let tags = item.tags
  if (!tags && item.tag) tags = [item.tag]
  if (!Array.isArray(tags)) tags = tags ? [tags] : []
  return {
    name: item.name,
    price: Number(item.price) || 0,
    tags: tags.filter(Boolean)
  }
}

function normalizeDay(day, index) {
  const dayNum = day.day != null ? Number(day.day) : index + 1
  return {
    day: dayNum,
    date: day.date || `Day ${dayNum}`,
    weather: day.weather || '',
    activities: (day.activities || []).map(normalizeActivity).filter(Boolean),
    meals: (day.meals || []).map(normalizeMeal).filter(Boolean),
    hotel: day.hotel ? normalizeHotel(day.hotel) : null,
    location: day.location || null
  }
}

function hasPlanShape(obj) {
  if (!obj || typeof obj !== 'object') return false
  return obj.summary != null || Array.isArray(obj.days)
}

/** 从 markdown 或混合文本中提取 JSON 片段 */
function extractJsonText(text) {
  if (!text || typeof text !== 'string') return ''
  const raw = text.trim()
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) return fenceMatch[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return raw
}

/** 修复 LLM 在字符串值内输出的未转义双引号，如 （"晋魂"基本陈列） */
function repairUnescapedQuotes(json) {
  let result = ''
  let inString = false
  let escape = false

  for (let i = 0; i < json.length; i++) {
    const c = json[i]
    if (escape) {
      result += c
      escape = false
      continue
    }
    if (c === '\\' && inString) {
      result += c
      escape = true
      continue
    }
    if (c === '"') {
      if (!inString) {
        inString = true
        result += c
      } else {
        let j = i + 1
        while (j < json.length && /\s/.test(json[j])) j++
        const next = json[j]
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false
          result += c
        } else {
          result += '\\"'
        }
      }
      continue
    }
    result += c
  }
  return result
}

function tryParseJsonString(str) {
  if (!str || typeof str !== 'string') return null
  const candidates = []
  const extracted = extractJsonText(str)
  if (extracted) candidates.push(extracted)
  const raw = str.trim()
  if (raw && raw !== extracted) candidates.push(raw)

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
    try {
      return JSON.parse(candidate)
    } catch (e) { /* continue */ }
    try {
      return JSON.parse(repairUnescapedQuotes(candidate))
    } catch (e2) { /* continue */ }
  }
  return null
}

/**
 * 从 API / 流式 buffer 各种包装中提取 { summary, days }
 * 支持：{ data }, { result }, { plan }, { code, data }, content/planJson 字符串字段
 */
function unwrapPayload(data, depth) {
  const level = depth || 0
  if (data == null || level > 6) return null

  if (typeof data === 'string') {
    return unwrapPayload(tryParseJsonString(data), level + 1)
  }

  if (typeof data !== 'object') return null

  if (hasPlanShape(data)) return data

  const stringFields = ['content', 'planJson', 'planText', 'rawText', 'text', 'response']
  for (let i = 0; i < stringFields.length; i++) {
    const key = stringFields[i]
    if (typeof data[key] === 'string') {
      const parsed = tryParseJsonString(data[key])
      if (parsed) {
        const inner = unwrapPayload(parsed, level + 1)
        if (inner && hasPlanShape(inner)) return inner
      }
    }
  }

  const nestedKeys = ['data', 'result', 'plan', 'payload', 'body', 'planResult']
  for (let j = 0; j < nestedKeys.length; j++) {
    const key = nestedKeys[j]
    const nested = data[nestedKeys[j]]
    if (nested != null) {
      const inner = unwrapPayload(nested, level + 1)
      if (inner && hasPlanShape(inner)) return inner
    }
  }

  if (data.code === 0 || data.code === 200 || data.success === true) {
    if (data.data != null) {
      const inner = unwrapPayload(data.data, level + 1)
      if (inner && hasPlanShape(inner)) return inner
    }
  }

  return null
}

/** 从流式累积文本或对象中解析 JSON */
function parsePlanJson(text) {
  if (text == null || text === '') return null
  if (typeof text === 'object') return unwrapPayload(text)

  const parsed = tryParseJsonString(String(text))
  if (parsed) return unwrapPayload(parsed)
  return null
}

function hasRenderableDay(d) {
  return !!(d && (d.activities.length > 0 || d.meals.length > 0 || d.hotel))
}

function hasRenderableContent(plan) {
  if (!plan) return false
  return !!plan.summary || (plan.days || []).some(hasRenderableDay)
}

/** 归一化为页面可用的 { summary, days }；骨架 day（仅有 day/date/weather）保留供 UI 占位 */
function normalizePlan(input) {
  const data = typeof input === 'string' ? parsePlanJson(input) : unwrapPayload(input)
  if (!data) return { summary: '', days: [] }

  const summary = String(data.summary || data.overview || '').trim()
  const rawDays = Array.isArray(data.days) ? data.days : []
  const days = rawDays.map(normalizeDay)

  return { summary, days }
}

function planToPlainText(plan) {
  const { summary, days } = normalizePlan(plan)
  const parts = []
  if (summary) parts.push(summary)

  days.forEach((d) => {
    let block = d.date || `Day ${d.day}`
    if (d.weather) block += `\n天气：${d.weather}`
    d.activities.forEach((a) => {
      const line = a.time ? `${a.time}：${a.desc}` : a.desc
      const extra = []
      if (a.locationName) extra.push(a.locationName)
      if (a.walkingDistance) extra.push('步行' + a.walkingDistance)
      block += '\n' + line + (extra.length ? '（' + extra.join('，') + '）' : '')
    })
    d.meals.forEach((m) => {
      block += `\n${m.type}：${m.name}${m.rating ? ' ⭐' + m.rating : ''}${m.comment ? '，' + m.comment : ''}`
    })
    if (d.hotel) {
      block += `\n住宿：${d.hotel.name}${d.hotel.price ? '，¥' + d.hotel.price + '/晚' : ''}`
      if (d.hotel.tags.length) block += '，' + d.hotel.tags.join('，')
    }
    parts.push(block)
  })

  return parts.join('\n\n').trim()
}

function isPlanJsonObject(obj) {
  if (!obj) return false
  const payload = unwrapPayload(obj)
  return !!(payload && hasPlanShape(payload))
}

/** 解析 GET /plan/result 响应（v0.3.5 ready 字段） */
function extractPlanFromResponse(res) {
  if (res == null) return { summary: '', days: [], ready: false, status: '', message: '' }

  const status = res.status || ''
  const message = res.message || ''

  if (typeof res === 'object' && res.ready === false) {
    return { summary: '', days: [], ready: false, status, message }
  }

  if (typeof res === 'object' && res.ready === true) {
    const plan = normalizePlan(res.planResult || res)
    return { summary: plan.summary, days: plan.days, ready: true, status, message }
  }

  const payload = unwrapPayload(res)
  const plan = normalizePlan(payload || res)
  return {
    summary: plan.summary,
    days: plan.days,
    ready: hasRenderableContent(plan),
    status,
    message
  }
}

module.exports = {
  parsePlanJson,
  normalizePlan,
  planToPlainText,
  normalizeDay,
  isPlanJsonObject,
  unwrapPayload,
  extractPlanFromResponse,
  extractJsonText,
  repairUnescapedQuotes,
  hasPlanShape,
  hasRenderableContent,
  hasRenderableDay
}

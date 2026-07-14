/**
 * 服务端标准 JSON 行程解析与归一化（权威数据轨 · §18 F-93）
 * {
 *   "summary": "行程概要",
 *   "days": [{ day, date, weather, activities, meals, hotel }]
 * }
 *
 * 天卡片 / 地图 / result 页 **只读本模块 + GET /plan/result**。
 * 禁止用 narrate / Markdown 展示流（stream-md）驱动 day-card。
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

/** 从 markdown 或混合文本中提取 JSON 片段（优先含 summary/days 的对象） */
function extractJsonText(text) {
  if (!text || typeof text !== 'string') return ''
  let raw = text.trim()
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) return fenceMatch[1].trim()

  // 未闭合 ```json 围栏：去掉开头标记再继续
  const openFence = raw.match(/```(?:json)?\s*/i)
  if (openFence) {
    raw = raw.slice(openFence.index + openFence[0].length).trim()
  }

  const planKey = raw.search(/\{[\s\n\r]*"(?:summary|days)"/)
  if (planKey >= 0) {
    const sliced = sliceBalancedObject(raw, planKey)
    if (sliced) return sliced
  }

  const start = raw.indexOf('{')
  if (start < 0) return raw
  const balanced = sliceBalancedObject(raw, start)
  if (balanced) return balanced
  const end = raw.lastIndexOf('}')
  if (end > start) return raw.slice(start, end + 1)
  return raw.slice(start)
}

/** 从 start（须为 `{`）切出括号平衡的对象；未闭合时返回尽量长的前缀供后续修复 */
function sliceBalancedObject(text, start) {
  if (!text || text[start] !== '{') return ''
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

/** SSE 误注入在 token 间的字面换行：解析失败时去掉再试 */
function stripTokenNewlines(str) {
  if (!str) return ''
  return String(str).replace(/\r\n/g, '\n').replace(/\n+/g, '')
}

/** 尽量闭合未完成的 JSON（流式截断；LIFO 关闭括号） */
function tryCloseIncompleteJson(str) {
  if (!str || typeof str !== 'string') return ''
  let s = str.trim()
  if (!s.startsWith('{') && !s.startsWith('[')) return s

  let inString = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString && c === '\\') {
      escape = true
      continue
    }
    if (c === '"') inString = !inString
  }
  if (inString) s += '"'

  const stack = []
  inString = false
  escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') stack.push('{')
    else if (c === '[') stack.push('[')
    else if (c === '}') {
      if (stack.length && stack[stack.length - 1] === '{') stack.pop()
    } else if (c === ']') {
      if (stack.length && stack[stack.length - 1] === '[') stack.pop()
    }
  }
  while (stack.length) {
    const open = stack.pop()
    s += open === '{' ? '}' : ']'
  }
  return s
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

  const variants = []
  candidates.forEach((c) => {
    variants.push(c)
    const stripped = stripTokenNewlines(c)
    if (stripped && stripped !== c) variants.push(stripped)
    const closed = tryCloseIncompleteJson(stripTokenNewlines(c) || c)
    if (closed && variants.indexOf(closed) < 0) variants.push(closed)
  })

  for (let i = 0; i < variants.length; i++) {
    const candidate = variants[i]
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

/**
 * 可展示为「完整行程卡片」：必须有至少一天可渲染内容。
 * 仅有 summary（流式截断补全出 days:[]）不算完成——否则会提前挂上满意提示 footer。
 */
function hasRenderableContent(plan) {
  if (!plan) return false
  return (plan.days || []).some(hasRenderableDay)
}

/** 流式过程中可增量展示：有 summary 或已解析出部分 days */
function hasStreamingPlanPreview(plan) {
  if (!plan) return false
  if ((plan.summary || '').trim()) return true
  return (plan.days || []).some(hasRenderableDay)
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
  hasStreamingPlanPreview,
  hasRenderableDay
}

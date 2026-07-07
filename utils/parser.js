/**
 * 旅行规划文本解析器（增强版）
 */

const TIME_SLOTS = ['上午', '下午', '晚上']
const MEAL_TYPES = ['早餐', '午餐', '晚餐', '夜宵']
const FIELD_PREFIXES = ['天气', '日期', '地点', '住宿', '交通', ...TIME_SLOTS, ...MEAL_TYPES]
const NARRATIVE_RE = /(让我们一起|来看看|安排得|真孝顺|先查|接下来|好的[，,]|收到[，,]|正在为你|我来帮你)/

function stripMarkdown(line) {
  return String(line || '')
    .replace(/^>\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^---+\s*#*\s*/, '')
    .trim()
}

function splitInlineSlots(text) {
  return String(text || '')
    .replace(/([^\n])(第\s*\d+\s*天)/g, '$1\n$2')
    .replace(/([^\n])(---\s*Day\s*\d+)/gi, '$1\n$2')
    .replace(/([^\n])(#{1,3}\s*Day\s*\d+)/gi, '$1\n$2')
    .replace(/([^\n])(#{1,3}\s*第\s*\d+\s*天)/g, '$1\n$2')
    .replace(/([^\n])(上午|下午|晚上|早餐|午餐|晚餐|夜宵|交通|住宿|天气|日期|地点)[：:]/g, '$1\n$2：')
}

/** 预处理：去 Markdown 残留、补换行、截掉正文前的思考过程 */
function preprocessPlanText(text) {
  if (isMarkdownPlan(text)) {
    return extractPlanBody(text)
  }

  let t = normalizeRawText(text)
  t = t
    .replace(/---+\s*#{1,3}\s*/g, '\n')
    .replace(/---+\s*/g, '\n')
    .replace(/^>\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
  t = splitInlineSlots(t)
  t = t.replace(/\n{3,}/g, '\n\n').trim()

  const startRe = /(?:---\s*Day\s*\d+\s*---|#{1,3}\s*Day\s*\d+\b|#{1,3}\s*第\s*\d+\s*天|【\s*Day\s*\d+\s*】|第\s*\d+\s*天|Day\s*\d+\s*[·:：])/i
  const m = t.match(startRe)
  if (m && m.index > 0) {
    t = t.slice(m.index).trim()
  }
  return t
}

function isMarkdownPlan(text) {
  const t = sanitizePlanText(text)
  return /##\s*🗺️|##\s*[^\n]{0,20}行程规划|###\s*💰|###\s*📅/.test(t)
    || (/\|.+\|/.test(t) && /###/.test(t))
}

/** 截取正式行程正文（去掉 AI 思考开场白） */
function extractPlanBody(text) {
  let t = sanitizePlanText(text)
  const patterns = [
    /---\s*\n+\s*(##\s*🗺️[^\n]*)/,
    /(##\s*🗺️[^\n]*)/,
    /(##\s*[^\n]{0,30}行程规划[^\n]*)/,
    /(###\s*📅\s*详细行程[^\n]*)/
  ]
  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i])
    if (m && m.index != null) {
      const start = m.index + (m[0].indexOf(m[1]))
      t = t.slice(start).trim()
      break
    }
  }
  return t
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{3,}/.test(String(line || '').trim())
}

function parseTableRow(line) {
  return String(line || '').split('|')
    .map((c) => stripMarkdown(c))
    .filter((c, idx, arr) => {
      if (idx === 0 && !c) return false
      if (idx === arr.length - 1 && !c) return false
      return true
    })
}

function isTableLikeLine(line) {
  const s = String(line || '').trim()
  if (!s.includes('|')) return false
  return (s.match(/\|/g) || []).length >= 2
}

function formatMarkdownTable(tableLines) {
  const rows = tableLines
    .filter((l) => !isTableSeparator(l))
    .map(parseTableRow)
    .filter((r) => r.length > 0)
  if (rows.length < 2) return tableLines.join('\n')

  const dataRows = rows.slice(1)
  const lines = []
  dataRows.forEach((row) => {
    if (row.length >= 2 && !/^时间$|^项目$|^活动$|^说明$/.test(row[0])) {
      const label = row[0]
      const rest = row.slice(1).filter(Boolean).join(' · ')
      lines.push(`  ${label}：${rest}`)
    } else if (row.length === 1 && row[0]) {
      lines.push(`  · ${row[0]}`)
    }
  })
  return lines.join('\n')
}

function convertMarkdownTables(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isTableLikeLine(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines = [line]
      i++
      tableLines.push(lines[i])
      i++
      while (i < lines.length && isTableLikeLine(lines[i])) {
        tableLines.push(lines[i])
        i++
      }
      out.push(formatMarkdownTable(tableLines))
      out.push('')
      continue
    }
    out.push(line)
    i++
  }
  return out.join('\n')
}

function splitMarkdownDayBlocks(text) {
  const body = extractPlanBody(text)
  const markers = []
  const re = /📅\s*Day\s*(\d+)\s*[（(]?[^\n|）)]*[）)]?/gi
  let m
  while ((m = re.exec(body)) !== null) {
    markers.push({
      index: m.index,
      end: m.index + m[0].length,
      dayNum: parseInt(m[1], 10),
      title: m[0].replace(/^\|+|\|+$/g, '').trim()
    })
  }
  if (!markers.length) return []

  return markers.map((marker, i) => {
    const start = marker.end
    const end = i + 1 < markers.length ? markers[i + 1].index : body.length
    return {
      dayNum: marker.dayNum,
      title: marker.title,
      content: body.slice(start, end)
    }
  })
}

function parseMarkdownDayBlock(dayNum, title, block) {
  const dayData = {
    day: dayNum,
    date: title || `Day ${dayNum}`,
    weather: '',
    activities: [],
    meals: [],
    hotel: null,
    location: null
  }

  String(block || '').split('\n').forEach((rawLine) => {
    const line = rawLine.trim()
    if (!line || isTableSeparator(line)) return
    if (/^时间.*活动.*说明/.test(line.replace(/\|/g, ''))) return

    if (isTableLikeLine(line)) {
      const cols = parseTableRow(line)
      if (cols.length >= 2 && !/^时间$|^项目$/.test(cols[0])) {
        const time = cols[0]
        const activity = cols[1]
        const note = cols[2] || ''
        const desc = note ? `${activity}（${note}）` : activity
        const type = /交通|高铁|地铁|打车|乘车|抵达|出发/.test(time + desc) ? '交通' : '景点'
        dayData.activities.push({
          time,
          desc,
          type,
          walkingDistance: extractWalkingDistance(desc),
          lat: null,
          lng: null
        })
      }
      return
    }

    for (const slot of TIME_SLOTS) {
      if (line.startsWith(slot + '：') || line.startsWith(slot + ':')) {
        dayData.activities.push(parseActivityLine(slot, line))
        return
      }
    }
    for (const meal of MEAL_TYPES) {
      if (line.startsWith(meal + '：') || line.startsWith(meal + ':')) {
        const mealData = parseMealLine(line)
        if (mealData) dayData.meals.push(mealData)
        return
      }
    }
    if (/^住宿[：:]/.test(line)) {
      dayData.hotel = parseHotelLine(line)
    } else if (/^天气[：:]/.test(line)) {
      dayData.weather = line.replace(/^天气[：:]\s*/, '').trim()
    }
  })

  return dayData
}

function isStructuredLine(line) {
  const s = stripMarkdown(line).replace(/^[-*•]\s*/, '')
  if (!s) return false
  if (FIELD_PREFIXES.some((p) => s.startsWith(p + '：') || s.startsWith(p + ':'))) return true
  if (/^(📍|🏨|🏡|🍽|☀️|🚄|🚇|🌤)/.test(s)) return true
  if (/^Day\s*\d/i.test(s)) return true
  if (/^第\s*\d+\s*天/.test(s)) return true
  return false
}

function isNarrativeLine(line) {
  const s = stripMarkdown(line)
  if (!s) return true
  if (isStructuredLine(line)) return false
  if (s.length > 100) return true
  if (NARRATIVE_RE.test(s)) return true
  if (/^(哈哈|嗯|好的|那|首先|另外|总之)/.test(s) && s.length > 40) return true
  return false
}

function extractWalkingDistance(text) {
  const m = text.match(/(?:步行|走路)?\s*(\d+(?:\.\d+)?)\s*(?:km|公里|米|m)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:km|公里)/i)
  return m ? m[0].trim() : ''
}

function extractCoords(text) {
  const m = text.match(/(?:lat|lng|经纬度)?[：:]?\s*([\d.]+)\s*[,，]\s*([\d.]+)/i)
    || text.match(/([\d.]{4,})\s*[,，]\s*([\d.]{4,})/)
  if (m) {
    return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
  }
  return null
}

function parseActivityLine(time, rawLine) {
  const line = stripMarkdown(rawLine)
  let content = line
    .replace(new RegExp(`^\\*?\\*?${time}\\*?\\*?[：:]\\s*`), '')
    .trim()

  let type = '景点'
  if (/^\*?\*?交通\*?\*?[：:]/.test(rawLine) || /^交通[：:]/.test(line) || /地铁|公交|打车|高铁|飞机|乘车/.test(content)) {
    type = '交通'
    content = content.replace(/^交通[：:]\s*/, '').trim()
  }

  const coords = extractCoords(content)
  if (coords) {
    content = content.replace(/[\d.]+\s*[,，]\s*[\d.]+/, '').trim()
  }

  return {
    time,
    desc: content,
    type,
    walkingDistance: extractWalkingDistance(content),
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null
  }
}

function parseTransportLine(rawLine) {
  const line = stripMarkdown(rawLine)
  const content = line.replace(/^交通[：:]\s*/, '').trim()
  const coords = extractCoords(content)
  return {
    time: '',
    desc: content.replace(/[\d.]+\s*[,，]\s*[\d.]+/, '').trim(),
    type: '交通',
    walkingDistance: extractWalkingDistance(content),
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null
  }
}

function parseMealLine(rawLine) {
  const line = stripMarkdown(rawLine)
  let type = ''
  for (const meal of MEAL_TYPES) {
    const re = new RegExp(`^\\*?\\*?${meal}\\*?\\*?[：:]`)
    if (re.test(line) || line.startsWith(meal + '：') || line.startsWith(meal + ':')) {
      type = meal
      break
    }
  }
  if (!type) return null

  let rest = line.replace(new RegExp(`^\\*?\\*?${type}\\*?\\*?[：:]\\s*`), '').trim()
  let rating = 0
  const ratingMatch = rest.match(/[⭐★]\s*(\d+(?:\.\d+)?)|评分\s*[：:]?\s*(\d+(?:\.\d+)?)/)
  if (ratingMatch) {
    rating = parseFloat(ratingMatch[1] || ratingMatch[2]) || 0
    rest = rest.replace(ratingMatch[0], '').replace(/^[，,、\s]+/, '').trim()
  }
  const parts = rest.split(/[，,|｜]/).map(s => s.trim()).filter(Boolean)
  return {
    type,
    name: parts[0] || rest,
    rating,
    comment: parts.slice(1).join('，') || ''
  }
}

function parseHotelLine(rawLine) {
  const line = stripMarkdown(rawLine)
  const content = line.replace(/^\*?\*?住宿\*?\*?[：:]\s*/, '').replace(/^住宿[：:]\s*/, '').trim()
  let price = 0
  const priceMatch = content.match(/[¥￥]?\s*(\d+)\s*元/) || content.match(/[¥￥](\d+)/)
  if (priceMatch) price = parseInt(priceMatch[1], 10)

  const parts = content
    .replace(/[¥￥]?\s*\d+\s*元/g, '')
    .split(/[，,|｜]/)
    .map(s => s.trim())
    .filter(Boolean)

  const name = parts[0] || content.split(/[，,]/)[0] || content
  const tags = parts.slice(1).filter(t => t && !/^\d+$/.test(t))
  return { name, price, tags }
}

function matchLinePrefix(line, prefix) {
  const stripped = stripMarkdown(line)
  return stripped.startsWith(prefix + '：') || stripped.startsWith(prefix + ':')
    || new RegExp(`^\\*?\\*?${prefix}\\*?\\*?[：:]`).test(line)
}

function parseDayBlock(dayNum, block) {
  const lines = splitInlineSlots(block)
    .split('\n')
    .map(l => stripMarkdown(l.trim()))
    .filter(Boolean)
  const dayData = {
    day: dayNum,
    date: '',
    weather: '',
    activities: [],
    meals: [],
    hotel: null,
    location: null
  }

  lines.forEach((rawLine) => {
    const line = stripMarkdown(rawLine)
    const normalized = line.replace(/^[-*•]\s*/, '')

    if (isTableLikeLine(normalized) || isTableSeparator(normalized)) {
      return
    }

    if (matchLinePrefix(rawLine, '天气') || /^天气[：:]/.test(normalized)) {
      dayData.weather = normalized.replace(/^天气[：:]\s*/, '').trim()
    } else if (matchLinePrefix(rawLine, '日期') || /^日期[：:]/.test(normalized)) {
      dayData.date = normalized.replace(/^日期[：:]\s*/, '').trim()
    } else if (matchLinePrefix(rawLine, '地点') || /^地点[：:]/.test(normalized)) {
      const locStr = normalized.replace(/^地点[：:]\s*/, '').trim()
      const coords = extractCoords(locStr)
      dayData.location = {
        name: locStr.replace(/[\d.]+\s*[,，]\s*[\d.]+/, '').trim() || locStr,
        latitude: coords ? coords.lat : null,
        longitude: coords ? coords.lng : null
      }
    } else if (matchLinePrefix(rawLine, '住宿') || /^住宿[：:]/.test(normalized)) {
      dayData.hotel = parseHotelLine(normalized)
    } else if (matchLinePrefix(rawLine, '交通') || /^\*?\*?交通\*?\*?[：:]/.test(rawLine) || /^交通[：:]/.test(normalized)) {
      const act = parseTransportLine(normalized)
      if (act.desc) dayData.activities.push(act)
    } else {
      let matched = false
      for (const slot of TIME_SLOTS) {
        if (matchLinePrefix(rawLine, slot) || normalized.startsWith(slot + '：') || normalized.startsWith(slot + ':')) {
          dayData.activities.push(parseActivityLine(slot, normalized))
          matched = true
          break
        }
      }
      if (!matched) {
        for (const meal of MEAL_TYPES) {
          if (matchLinePrefix(rawLine, meal) || normalized.startsWith(meal + '：') || normalized.startsWith(meal + ':')) {
            const mealData = parseMealLine(normalized)
            if (mealData) dayData.meals.push(mealData)
            matched = true
            break
          }
        }
      }
      if (!matched && normalized.length > 2 && !/^Day\s*\d/i.test(normalized) && !isNarrativeLine(normalized)) {
        if (normalized.length <= 120) {
          dayData.activities.push({
            time: '',
            desc: normalized,
            type: '景点',
            walkingDistance: extractWalkingDistance(normalized),
            lat: null,
            lng: null
          })
        }
      }
    }
  })

  if (!dayData.date) {
    dayData.date = `Day ${dayNum}`
  }
  dayData.activities = (dayData.activities || []).filter((a) => {
    if (a.time) return !!a.desc
    return a.desc && a.desc.length <= 80
  })
  return dayData
}

function isValidDay(dayData) {
  if (!dayData) return false
  const timedActivities = (dayData.activities || []).filter((a) => a.time && a.desc && !isTableLikeLine(a.desc))
  const cleanMeals = (dayData.meals || []).length
  return timedActivities.length >= 1
    || cleanMeals > 0
    || !!dayData.hotel
}

function normalizeRawText(text) {
  if (!text) return ''
  return String(text)
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/** 清洗流式累积文本，去除 JSON 碎片与无效行 */
function sanitizePlanText(text) {
  let t = normalizeRawText(text)
  const lines = t.split('\n').filter((line) => {
    const s = line.trim()
    if (!s) return true
    if (/^\{"(choices|id|object|created|model|usage)"\s*:/.test(s)) return false
    if (/^"(choices|delta|finish_reason|role|content|index)"\s*:/.test(s)) return false
    if (/^\[DONE\]$/.test(s)) return false
    if (s === 'data:' || s.startsWith('data: {')) return false
    if (/^[}\],]+$/.test(s)) return false
    if (/^\{"content"\s*:/.test(s)) return false
    if (/^---+\s*#*\s*$/.test(s)) return false
    return true
  })
  t = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return t
}

/** 格式化为可读纯文本（Markdown 行程） */
function formatPlanText(text) {
  let t = extractPlanBody(sanitizePlanText(text))
  if (!t) return ''
  t = t.replace(/\*\*(.+?)\*\*/g, '$1')
  t = convertMarkdownTables(t)
  t = t
    .replace(/^##\s+/gm, '\n')
    .replace(/^###\s+/gm, '\n')
    .replace(/^---+\s*$/gm, '')
    .replace(/^(---\s*Day\s*\d+\s*---|#{1,3}\s*Day\s*\d+|#{1,3}\s*第\s*\d+\s*天|【Day\s*\d+】|第\s*\d+\s*天)/gm, '\n$1\n')
    .replace(/^(上午|下午|晚上|早餐|午餐|晚餐|夜宵|交通|住宿|天气|日期|地点)[：:]/gm, '\n$1：')
    .replace(/^[-*•]\s*(上午|下午|晚上|早餐|午餐|晚餐|夜宵|交通|住宿|天气|日期|地点)[：:]/gm, '\n$1：')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t
}

function splitDayBlocks(text) {
  const clean = preprocessPlanText(sanitizePlanText(text))
  const blocks = []
  const markers = []
  // 扩展 Day 识别：--- Day 1 --- / ## Day 1 / 【Day 1】 / 第1天 / Day 1 · / ### 第一天
  const re = /(?:---\s*Day\s*(\d+)\s*---|#{1,3}\s*Day\s*(\d+)\b|#{1,3}\s*第\s*([一二三四五六七八九十\d]+)\s*天|【\s*Day\s*(\d+)\s*】|第\s*(\d+)\s*天|(?:^|\n)\s*Day\s*(\d+)\s*[·:：]|(?:^|\n)\s*Day\s*(\d+)\b(?!\s*[-·:：]))/gi

  const cnNumMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

  function resolveDayNum(...groups) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      if (!g) continue
      if (/^\d+$/.test(g)) return parseInt(g, 10)
      if (cnNumMap[g]) return cnNumMap[g]
      if (g === '十') return 10
      const m = g.match(/^十([一二三四五六七八九])$/)
      if (m) return 10 + (cnNumMap[m[1]] || 0)
    }
    return 0
  }
  let m
  while ((m = re.exec(clean)) !== null) {
    const dayNum = resolveDayNum(m[1], m[2], m[3], m[4], m[5], m[6], m[7])
    if (!dayNum) continue
    markers.push({ index: m.index, end: m.index + m[0].length, dayNum })
  }
  if (!markers.length) {
    if (isMarkdownPlan(clean)) return []
    const body = clean.trim()
    if (body) blocks.push({ dayNum: 1, content: body })
    return blocks
  }

  markers.forEach((marker, i) => {
    const start = marker.end
    const end = i + 1 < markers.length ? markers[i + 1].index : clean.length
    const content = clean.slice(start, end)
    if (content.trim()) {
      blocks.push({ dayNum: marker.dayNum, content })
    }
  })
  return blocks
}

function isGoodMarkdownDays(days) {
  if (!days || !days.length) return false
  return days.every((d) => {
    const acts = (d.activities || []).filter((a) => a.time && a.desc && !isTableLikeLine(a.desc))
    return acts.length >= 2
  })
}

function parseTravelPlan(text) {
  if (!text || !text.trim()) return []
  const clean = sanitizePlanText(text)

  if (isMarkdownPlan(clean)) {
    const mdDays = splitMarkdownDayBlocks(clean)
      .map(({ dayNum, title, content }) => parseMarkdownDayBlock(dayNum, title, content))
      .filter(isValidDay)
    if (mdDays.length > 0) return mdDays
    return []
  }

  const normalized = preprocessPlanText(clean)
  return splitDayBlocks(normalized)
    .map(({ dayNum, content }) => parseDayBlock(dayNum, content))
    .filter(isValidDay)
}

function countDays(text) {
  if (!text) return 0
  return splitDayBlocks(text).length
}

function extractOverview(text, preferences) {
  const prefs = preferences || {}
  const dayCount = countDays(text)
  return {
    dateRange: dayCount > 0 ? `${dayCount} 天行程` : '行程概览',
    budget: prefs.budget ? `¥${prefs.budget}` : '预算待定',
    styles: prefs.styles || []
  }
}

function toPlainText(days, rawText) {
  if (days && days.length > 0) {
    let text = ''
    days.forEach((d) => {
      text += `第 ${d.day} 天`
      if (d.date && d.date !== `Day ${d.day}`) text += ` · ${d.date}`
      text += '\n'
      if (d.weather) text += `天气：${d.weather}\n`
      d.activities.forEach((a) => {
        if (a.time) text += `${a.time}：${a.desc}\n`
        else if (a.desc) text += `· ${a.desc}\n`
      })
      d.meals.forEach((m) => {
        text += `${m.type}：${m.name}${m.rating ? ' ⭐' + m.rating : ''}${m.comment ? '，' + m.comment : ''}\n`
      })
      if (d.hotel) {
        text += `住宿：${d.hotel.name}${d.hotel.price ? '，¥' + d.hotel.price : ''}${d.hotel.tags && d.hotel.tags.length ? '，' + d.hotel.tags.join('，') : ''}\n`
      }
      text += '\n'
    })
    return text.trim()
  }
  return formatPlanText(rawText)
}

module.exports = {
  parseTravelPlan,
  extractOverview,
  toPlainText,
  countDays,
  sanitizePlanText,
  formatPlanText,
  preprocessPlanText,
  isMarkdownPlan,
  extractPlanBody,
  isGoodMarkdownDays
}

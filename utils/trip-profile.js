/**
 * v0.5.0 INTAKE 旅游要素 tripProfile 构建与进度估算
 */

const INTAKE_TOTAL = 7

const COMPANION_OPTIONS = [
  { value: 'solo', label: '独自' },
  { value: 'couple', label: '情侣' },
  { value: 'family', label: '亲子' },
  { value: 'with_elderly', label: '带老人' },
  { value: 'friends', label: '朋友结伴' }
]

const PACE_OPTIONS = [
  { value: 'intensive', label: '特种兵打卡' },
  { value: 'moderate', label: '适中' },
  { value: 'relaxed', label: '松弛度假' }
]

const TRANSPORT_MODES = [
  { value: 'flight', label: '飞机' },
  { value: 'train', label: '火车/高铁' },
  { value: 'self_drive', label: '自驾' },
  { value: 'mixed', label: '混合' },
  { value: 'local_only', label: '当地交通' }
]

const TIME_SLOTS = [
  { value: 'early', label: '清晨/红眼' },
  { value: 'morning', label: '上午' },
  { value: 'afternoon', label: '下午' },
  { value: 'late', label: '傍晚/深夜' },
  { value: 'unknown', label: '不确定' }
]

const DIETARY_TAGS = ['海鲜过敏', '素食', '清真', '无辣', '少油少盐']
const MOBILITY_TAGS = ['恐高', '晕车', '行动不便', '不宜久走']

const STYLE_TO_INTEREST = {
  food: 'food',
  culture: 'culture',
  nature: 'nature',
  photography: 'photography',
  shopping: 'shopping',
  adventure: 'outdoor'
}

const INTEREST_OPTIONS = [
  { code: 'food', label: '美食', emoji: '🍜' },
  { code: 'culture', label: '文化', emoji: '🏛️' },
  { code: 'nature', label: '自然', emoji: '🏔️' },
  { code: 'photography', label: '摄影', emoji: '📷' },
  { code: 'shopping', label: '购物', emoji: '🛍️' },
  { code: 'outdoor', label: '户外', emoji: '🧗' }
]

const INTAKE_CATEGORIES = [
  'companions', 'travelTiming', 'pace', 'interests', 'constraints', 'transport', 'supplement'
]

const CATEGORY_LABELS = {
  companions: '同行人',
  travelTiming: '出行时间',
  pace: '体力偏好',
  interests: '兴趣侧重',
  constraints: '特殊限制',
  transport: '大交通',
  supplement: '补充确认',
  other: '其他'
}

const INTAKE_PROMPTS = {
  companions: '请问您是独自旅行、情侣出行、亲子家庭，还是朋友结伴呢？',
  travelTiming: '大概什么时间段出行？给个大致范围就行~',
  pace: '您偏好哪种旅行节奏？特种兵打卡、适中，还是松弛度假？',
  interests: '这次更侧重哪些方面？比如美食、文化、自然风光、摄影等。',
  constraints: '有没有饮食或行动方面的特殊限制？没有的话也请告诉我~',
  transport: '从出发地到目的地，您打算用什么交通方式？回程怎么安排？',
  supplement: '还有需要补充的吗？比如特别想去或不想去的地方？'
}

const FORM_DRAFT_KEY = 'index_trip_profile_draft_v1'

function currentYearMonth() {
  const d = new Date()
  const m = d.getMonth() + 1
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m
}

/** 去掉已过月份（草稿/预填占位），避免 INTAKE 弹出「2026年6月，没错」类过期选项 */
function normalizeTravelMonthValue(month) {
  if (!month || typeof month !== 'string') return ''
  const trimmed = month.trim()
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return ''
  if (trimmed < currentYearMonth()) return ''
  return trimmed
}

function paceFromDailySteps(steps) {
  const n = parseInt(steps, 10)
  if (!n || isNaN(n)) return ''
  if (n <= 6000) return 'relaxed'
  if (n >= 15000) return 'intensive'
  return 'moderate'
}

function hasCompanions(profile) {
  const c = profile && profile.companions
  if (!c || !c.type) return false
  if (c.type === 'family') {
    return Array.isArray(c.details && c.details.childAges) && c.details.childAges.length > 0
  }
  if (c.type === 'with_elderly') {
    return !!(c.details && c.details.elderlyCount)
  }
  if (c.type === 'friends') {
    return !!(c.details && c.details.groupSize)
  }
  return true
}

function hasTravelTiming(profile) {
  const t = profile && profile.travelTiming
  if (!t) return false
  return !!(t.month || t.startDate)
}

function hasPace(profile) {
  return !!(profile && profile.pace)
}

function hasInterests(profile) {
  const list = profile && profile.interests
  if (!Array.isArray(list) || !list.length) return false
  return list.every((item) => item && item.code && item.rank != null)
}

function hasConstraints(profile) {
  const c = profile && profile.constraints
  if (!c) return false
  const dietary = Array.isArray(c.dietary) ? c.dietary : []
  const mobility = Array.isArray(c.mobility) ? c.mobility : []
  const noLimit = c.noLimit === true
  // extraNotes 等合并进 other 的文本不能代替 INTAKE「无限制」显式确认
  return noLimit || dietary.length > 0 || mobility.length > 0
}

function hasTransport(profile) {
  const t = profile && profile.transport
  if (!t || !t.mode) return false
  return !!(t.outbound && t.inbound)
}

function computeMissing(profile, supplementConfirmed) {
  const missing = []
  if (!hasCompanions(profile)) missing.push('companions')
  if (!hasTravelTiming(profile)) missing.push('travelTiming')
  if (!hasPace(profile)) missing.push('pace')
  if (!hasInterests(profile)) missing.push('interests')
  if (!hasConstraints(profile)) missing.push('constraints')
  if (!hasTransport(profile)) missing.push('transport')
  if (!supplementConfirmed) missing.push('supplement')
  return missing
}

function estimateIntakeProgress(tripProfile, supplementConfirmed) {
  const profile = tripProfile || {}
  const missing = computeMissing(profile, !!supplementConfirmed)
  const filled = INTAKE_TOTAL - missing.length
  return {
    filled,
    total: INTAKE_TOTAL,
    missing,
    supplementConfirmed: !!supplementConfirmed
  }
}

function progressForPendingCategory(category) {
  const idx = INTAKE_CATEGORIES.indexOf(category)
  if (idx < 0) return null
  return {
    filled: idx,
    total: INTAKE_TOTAL,
    missing: INTAKE_CATEGORIES.slice(idx),
    supplementConfirmed: false
  }
}

function countIntakeDialogStats(messages) {
  const stats = { userText: 0, assistantText: 0 }
  ;(messages || []).forEach((m) => {
    if (!m || m.type === 'thinking' || m.type === 'phase') return
    if (m.role === 'user' && (m.type === 'text' || m.type === 'answer')) stats.userText++
    else if (m.role === 'assistant' && m.type === 'text') stats.assistantText++
  })
  return stats
}

/** 冷恢复：服务端未带 intakeProgress 时，按已持久化 Q&A 条数估算进度 */
function estimateIntakeProgressFromDialog(messages) {
  const stats = countIntakeDialogStats(messages)
  if (!stats.userText && !stats.assistantText) return null
  const answeredRounds = Math.max(0, stats.userText - 1)
  let filled = answeredRounds
  if (stats.assistantText > answeredRounds) {
    filled = answeredRounds + 1
  }
  if (stats.assistantText > 0 && filled < 1) filled = 1
  filled = Math.min(filled, INTAKE_TOTAL)
  return {
    filled,
    total: INTAKE_TOTAL,
    missing: INTAKE_CATEGORIES.slice(filled),
    supplementConfirmed: false
  }
}

function defaultOptionsForCategory(category) {
  if (category === 'supplement') {
    return ['没有补充了，开始规划吧']
  }
  if (category === 'constraints') {
    return ['无饮食/行动限制']
  }
  return []
}

function tripProfileFingerprint(profile) {
  if (!profile) return ''
  try {
    return JSON.stringify(profile)
  } catch (e) {
    return ''
  }
}

function formatIntakeProgressLabel(progress) {
  if (!progress) return ''
  const filled = progress.filled != null ? progress.filled : 0
  const total = progress.total != null ? progress.total : INTAKE_TOTAL
  return `需求确认 (${filled}/${total})`
}

function isIntakeProgressComplete(progress) {
  if (!progress) return false
  const total = progress.total != null ? progress.total : INTAKE_TOTAL
  if (progress.supplementConfirmed) return true
  if (Array.isArray(progress.missing) && progress.missing.length === 0) return true
  const filled = progress.filled != null ? progress.filled : 0
  return filled >= total
}

function isCategoryConfirmed(category, intakeProgress) {
  if (!category || !intakeProgress) return false
  const missing = intakeProgress.missing
  if (!Array.isArray(missing)) return false
  return missing.indexOf(category) < 0
}

function buildInterestsFromStyles(styleValues, rankedCodes) {
  const codes = []
  if (Array.isArray(rankedCodes) && rankedCodes.length) {
    rankedCodes.forEach((code) => {
      if (code && codes.indexOf(code) < 0) codes.push(code)
    })
  }
  ;(styleValues || []).forEach((v) => {
    const code = STYLE_TO_INTEREST[v]
    if (code && codes.indexOf(code) < 0) codes.push(code)
  })
  return codes.map((code, i) => ({ code, rank: i + 1 }))
}

function buildTripProfile(form) {
  const profile = {}
  if (form.companionType) {
    profile.companions = { type: form.companionType, details: {} }
    const details = profile.companions.details
    if (form.companionType === 'family' && form.childAgesText) {
      details.childAges = form.childAgesText.split(/[,，\s]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n >= 0)
    }
    if (form.companionType === 'with_elderly' && form.elderlyCount) {
      details.elderlyCount = parseInt(form.elderlyCount, 10) || undefined
    }
    if (form.companionType === 'friends' && form.groupSize) {
      details.groupSize = parseInt(form.groupSize, 10) || undefined
    }
  }
  const travelMonth = normalizeTravelMonthValue(form.travelMonth)
  if (travelMonth || form.travelStartDate || form.travelEndDate) {
    profile.travelTiming = {}
    if (travelMonth) profile.travelTiming.month = travelMonth
    if (form.travelStartDate) profile.travelTiming.startDate = form.travelStartDate
    if (form.travelEndDate) profile.travelTiming.endDate = form.travelEndDate
    if (form.travelFlexible) profile.travelTiming.flexible = true
  }
  if (form.pace) {
    profile.pace = form.pace
  } else if (form.dailySteps) {
    const inferred = paceFromDailySteps(form.dailySteps)
    if (inferred) profile.pace = inferred
  }
  const interests = buildInterestsFromStyles(form.styleValues, form.rankedInterestCodes)
  if (interests.length) profile.interests = interests
  const dietary = (form.dietaryTags || []).slice()
  const mobility = (form.mobilityTags || []).slice()
  const otherParts = []
  if ((form.extraNotes || '').trim()) otherParts.push(form.extraNotes.trim())
  if ((form.mustVisit || '').trim()) otherParts.push('必去：' + form.mustVisit.trim())
  if ((form.mustAvoid || '').trim()) otherParts.push('避开：' + form.mustAvoid.trim())
  if (form.constraintsNoLimit || dietary.length || mobility.length || otherParts.length) {
    profile.constraints = {
      dietary,
      mobility,
      other: otherParts.join('；') || undefined,
      noLimit: !!form.constraintsNoLimit
    }
  }
  if (form.transportMode) {
    profile.transport = {
      mode: form.transportMode,
      outbound: form.transportOutbound || undefined,
      inbound: form.transportInbound || undefined,
      departureCity: (form.departureCity || '').trim() || undefined
    }
  }
  if (form.companionType === 'family' && !profile.companions) {
    profile.companions = { type: 'family', details: {} }
  }
  if ((form.styleValues || []).indexOf('family') >= 0 && !profile.companions) {
    profile.companions = { type: 'family', details: {} }
  }
  if ((form.styleValues || []).indexOf('relaxation') >= 0 && !profile.pace) {
    profile.pace = 'relaxed'
  }
  return Object.keys(profile).length ? profile : null
}

function buildInterestList(selectedCodes) {
  const selected = selectedCodes || []
  return INTEREST_OPTIONS.map((item) => ({
    ...item,
    selected: selected.indexOf(item.code) >= 0,
    rank: selected.indexOf(item.code) >= 0 ? selected.indexOf(item.code) + 1 : 0
  }))
}

function loadFormDraft() {
  try {
    return wx.getStorageSync(FORM_DRAFT_KEY) || null
  } catch (e) {
    return null
  }
}

function saveFormDraft(data) {
  try {
    wx.setStorageSync(FORM_DRAFT_KEY, data)
  } catch (e) { /* ignore */ }
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || category || ''
}

function promptForCategory(category, query) {
  if (INTAKE_PROMPTS[category]) return INTAKE_PROMPTS[category]
  const dest = String(query || '').replace(/\d+天$/, '').trim()
  return dest
    ? `关于${dest}之行，请补充${categoryLabel(category)}相关信息~`
    : `请补充${categoryLabel(category)}相关信息~`
}

module.exports = {
  INTAKE_TOTAL,
  INTAKE_CATEGORIES,
  CATEGORY_LABELS,
  COMPANION_OPTIONS,
  PACE_OPTIONS,
  TRANSPORT_MODES,
  TIME_SLOTS,
  DIETARY_TAGS,
  MOBILITY_TAGS,
  INTEREST_OPTIONS,
  STYLE_TO_INTEREST,
  FORM_DRAFT_KEY,
  paceFromDailySteps,
  buildTripProfile,
  buildInterestsFromStyles,
  buildInterestList,
  estimateIntakeProgress,
  progressForPendingCategory,
  estimateIntakeProgressFromDialog,
  defaultOptionsForCategory,
  formatIntakeProgressLabel,
  tripProfileFingerprint,
  isIntakeProgressComplete,
  isCategoryConfirmed,
  categoryLabel,
  promptForCategory,
  loadFormDraft,
  saveFormDraft,
  currentYearMonth,
  normalizeTravelMonthValue
}

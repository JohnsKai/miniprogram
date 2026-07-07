function mergeConsecutiveDaysToRoute(messages) {
  const out = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (m.type === 'day' && m.dayData) {
      const days = []
      let j = i
      while (j < messages.length && messages[j].type === 'day' && messages[j].dayData) {
        days.push(messages[j].dayData)
        j++
      }
      if (days.length > 1) {
        out.push({
          ...m,
          id: (m.id || 'msg') + '_route',
          type: 'route',
          dayData: undefined,
          days,
          summary: m.summary || '',
          content: '',
          planBlock: true
        })
        i = j
        continue
      }
    }
    out.push(m)
    i++
  }
  return out
}

function normalizeUiMessages(messages) {
  const normalized = (messages || []).map((m) => ({
    ...m,
    planBlock: m.type === 'day' || m.type === 'summary' || m.type === 'route'
  }))
  return mergeConsecutiveDaysToRoute(normalized)
}

function isPlanMessage(m) {
  return !!(m && (m.planBlock || m.type === 'day' || m.type === 'summary' || m.type === 'route'))
}

function contentKey(m) {
  if (!m) return ''
  if (m.type === 'day' || m.type === 'route' || m.type === 'summary') {
    return [m.role, m.type, m.summary || '', JSON.stringify(m.days || m.dayData || '')].join('\0')
  }
  const content = String(m.content || '').trim()
  if (!content) return m.id ? 'id:' + m.id : ''
  return [m.role, m.type, content].join('\0')
}

function isPlanFooterMessage(m) {
  if (!m || m.role !== 'assistant' || m.type !== 'text') return false
  const text = String(m.content || '')
  return /如果你对行程满意|祝你旅途愉快/.test(text)
}

function stripPlanBlocks(messages) {
  return (messages || []).filter((m) => !isPlanMessage(m) && !isPlanFooterMessage(m))
}

function stripIntakeInterruptedPlan(messages) {
  return (messages || []).filter((m) => {
    if (m.type === 'phase' || m.type === 'thinking') return false
    if (isPlanMessage(m) || isPlanFooterMessage(m) || isPlanIntroMessage(m)) return false
    return true
  })
}

function isPlanIntroMessage(m) {
  if (!m || m.role !== 'assistant' || m.type !== 'text') return false
  return /规划好了|更新了行程|重新规划|我来为你规划|完整行程如下/.test(String(m.content || ''))
}

/** 仅前端 startPlanning / askInChat 产生的占位，不得覆盖服务端持久化消息 */
function isLocalIntakeNoise(m) {
  if (!m || m.role !== 'assistant' || m.type !== 'text') return false
  const text = String(m.content || '')
  if (/我来为你规划|请稍候/.test(text)) return true
  if (/^好的，请问/.test(text)) return true
  return false
}

function hasRenderablePlanResult(planResult) {
  if (!planResult) return false
  const summary = String(planResult.summary || '').trim()
  const days = planResult.days || []
  return !!summary || (Array.isArray(days) && days.length > 0)
}

function detectPlanIntroText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isPlanIntroMessage(m)) return m.content
  }
  return '为你规划好了，完整行程如下：'
}

function buildUnifiedPlanRoute(planResult, introText) {
  return {
    id: 'plan_unified',
    role: 'assistant',
    type: 'route',
    content: introText || '为你规划好了，完整行程如下：',
    summary: planResult.summary || '',
    days: planResult.days || [],
    footer: '如果你对行程满意可以直接参考；想调整细节或重新规划，回复告诉我就好。',
    planBlock: true
  }
}

function dedupeDialogMessages(messages) {
  const seen = new Set()
  const out = []
  ;(messages || []).forEach((m) => {
    if (m.type === 'thinking' || m.type === 'phase') return
    const k = contentKey(m)
    if (k && seen.has(k)) return
    if (k) seen.add(k)
    out.push(m)
  })
  return out
}

/** 同一 user 轮次内只保留最后一条 assistant 追问（末尾） */
function coalesceTrailingIntakeQuestions(messages) {
  const list = dedupeDialogMessages(messages)
  if (!list.length) return list
  let lastUserIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === 'user' && (m.type === 'text' || m.type === 'answer')) {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return list
  const head = list.slice(0, lastUserIdx + 1)
  const tail = list.slice(lastUserIdx + 1)
  let lastAssistantText = null
  const tailOther = []
  tail.forEach((m) => {
    if (m.role === 'assistant' && m.type === 'text') {
      lastAssistantText = m
      return
    }
    tailOther.push(m)
  })
  const out = head.concat(tailOther)
  if (lastAssistantText) out.push(lastAssistantText)
  return out
}

/** 每个 user 发言前合并多条 assistant 追问为一条（去重 companions 双问） */
function coalesceIntakeQuestionRounds(messages) {
  const out = []
  let pendingAssistant = null
  ;(messages || []).forEach((m) => {
    if (m.type === 'phase' || m.type === 'thinking') return
    if (m.role === 'user') {
      if (pendingAssistant) {
        out.push(pendingAssistant)
        pendingAssistant = null
      }
      out.push(m)
      return
    }
    if (m.role === 'assistant' && m.type === 'text') {
      pendingAssistant = m
      return
    }
    if (pendingAssistant) {
      out.push(pendingAssistant)
      pendingAssistant = null
    }
    out.push(m)
  })
  if (pendingAssistant) out.push(pendingAssistant)
  return out
}

function coalescePlanBlocks(messages) {
  const out = []
  let i = 0
  const list = messages || []
  while (i < list.length) {
    const m = list[i]
    if (m.type === 'route') {
      let footer = m.footer || ''
      let j = i + 1
      if (!footer && j < list.length && isPlanFooterMessage(list[j])) {
        footer = list[j].content
        j++
      }
      out.push({ ...m, footer: footer || m.footer, planBlock: true })
      i = j
      continue
    }
    if (isPlanIntroMessage(m) || (m.type === 'summary' && m.summary)) {
      let intro = isPlanIntroMessage(m) ? m.content : ''
      let j = isPlanIntroMessage(m) ? i + 1 : i
      let summary = ''
      const days = []
      let footer = ''
      if (j < list.length && list[j].type === 'summary') {
        summary = list[j].summary || ''
        if (!intro && list[j].summary) intro = '为你规划好了，完整行程如下：'
        j++
      } else if (m.type === 'summary') {
        summary = m.summary || ''
        j = i + 1
      }
      while (j < list.length && list[j].type === 'day' && list[j].dayData) {
        days.push(list[j].dayData)
        j++
      }
      if (j < list.length && isPlanFooterMessage(list[j])) {
        footer = list[j].content
        j++
      }
      if (summary || days.length) {
        out.push({
          id: (m.id || 'plan') + '_route',
          role: 'assistant',
          type: 'route',
          content: intro || '为你规划好了，完整行程如下：',
          summary,
          days,
          footer,
          planBlock: true
        })
        i = j
        continue
      }
    }
    if (isPlanMessage(m) || isPlanFooterMessage(m)) {
      i++
      continue
    }
    out.push(m)
    i++
  }
  return out
}

function countDialogStats(messages) {
  const stats = { total: 0, userText: 0, assistantText: 0, planBlocks: 0, other: 0 }
  ;(messages || []).forEach((m) => {
    stats.total++
    if (isPlanMessage(m) || isPlanFooterMessage(m)) {
      stats.planBlocks++
    } else if (m.role === 'user' && (m.type === 'text' || m.type === 'answer')) {
      stats.userText++
    } else if (m.role === 'assistant' && m.type === 'text') {
      stats.assistantText++
    } else if (m.type === 'summary' || m.type === 'day' || m.type === 'route') {
      stats.planBlocks++
    } else {
      stats.other++
    }
  })
  return stats
}

function summarizeMessages(messages, label) {
  const stats = countDialogStats(messages)
  const samples = (messages || []).slice(0, 5).map((m) => {
    const body = String(m.content || m.summary || '').slice(0, 24)
    return `${m.role}/${m.type}${body ? ':' + body : ''}`
  })
  return { label, ...stats, samples }
}

function serverMissingAssistantDialog(messages) {
  const stats = countDialogStats(messages)
  // 首条 user 为 query，允许 assistant 比 user 少 1 条
  return stats.userText > 1 && stats.assistantText < stats.userText - 1
}

/** INTAKE 对话：去重 + 末尾重复追问合并；#77 后服务端已持久化完整 Q&A，勿再 coalesceIntakeQuestionRounds 折叠历史 */
function prepareIntakeDialog(messages, options) {
  options = options || {}
  const list = dedupeDialogMessages(
    (messages || []).filter((m) => m.type !== 'phase' && m.type !== 'thinking')
  )
  if (options.legacyCollapse) {
    return coalesceTrailingIntakeQuestions(coalesceIntakeQuestionRounds(list))
  }
  return coalesceTrailingIntakeQuestions(list)
}

function normalizeSessionMessages(messages, planResult, options) {
  options = options || {}
  let msgs = dedupeDialogMessages(messages)
  if (options.skipPlanRebuild) {
    return normalizeUiMessages(coalescePlanBlocks(msgs))
  }
  if (hasRenderablePlanResult(planResult)) {
    const intro = detectPlanIntroText(msgs)
    msgs = stripPlanBlocks(msgs)
    msgs.push(buildUnifiedPlanRoute(planResult, intro))
    return normalizeUiMessages(msgs)
  }
  return normalizeUiMessages(coalescePlanBlocks(msgs))
}

module.exports = {
  normalizeSessionMessages,
  normalizeUiMessages,
  stripPlanBlocks,
  stripIntakeInterruptedPlan,
  coalescePlanBlocks,
  coalesceTrailingIntakeQuestions,
  coalesceIntakeQuestionRounds,
  buildUnifiedPlanRoute,
  dedupeDialogMessages,
  contentKey,
  isPlanMessage,
  isPlanIntroMessage,
  isLocalIntakeNoise,
  countDialogStats,
  summarizeMessages,
  serverMissingAssistantDialog,
  prepareIntakeDialog
}

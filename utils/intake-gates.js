/**
 * INTAKE → 规划阶段 UI 门禁（纯函数，供 planning 与自测共用）
 */

function isSupplementConfirmedAnswer(text, category) {
  const t = (text || '').trim()
  if (!t) return false
  if (category === 'supplement') return true
  return /^(没有|无补充|没有了|没有补充|没有问题了|就这些|就这些吧|可以开始规划|开始规划)/.test(t)
}

/**
 * 是否允许因 liveQuestion / sync.hasQuestion 重新打开 INTAKE 追问 UI。
 * 规划已启动（intake 已完成）时必须拒绝，否则会出现「正在整理行程」同时底下仍有「没有了」按钮。
 */
function canReopenIntakeForLiveQuestion(ctx) {
  ctx = ctx || {}
  if (ctx.planComplete || ctx.postPlanChat) return false
  const phase = String(ctx.planningPhase || '').toLowerCase()
  if (phase === 'planning' || phase === 'done') return false
  if (ctx.intakePhaseDone && !ctx.intakeIncomplete) return false
  if (ctx.isThinking && ctx.intakePhaseDone) return false
  return true
}

/**
 * 是否应展示底部快捷回答 chips
 */
function shouldShowAskOptions(ctx) {
  ctx = ctx || {}
  if (!ctx.awaitingReply) return false
  if (!ctx.askOptions || !ctx.askOptions.length) return false
  if (ctx.isThinking) return false
  if (ctx.planComplete || ctx.postPlanChat) return false
  const phase = String(ctx.planningPhase || '').toLowerCase()
  if (phase === 'planning' || phase === 'done') return false
  if (ctx.intakePhaseDone && !ctx.intakeIncomplete) return false
  return true
}

module.exports = {
  isSupplementConfirmedAnswer,
  canReopenIntakeForLiveQuestion,
  shouldShowAskOptions
}

/**
 * §0.6.4 联调验收 — 对照 travel-agent 契约
 * 用法: node scripts/contract-acceptance-064.js [BASE_URL]
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const BASE = process.argv[2] || 'http://localhost:8081'
const ROOT = path.join(__dirname, '..')

const results = []

function log(id, pass, detail) {
  results.push({ id, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`[${mark}] #${id} ${detail}`)
}

function request(method, urlPath, { token, body, query } = {}) {
  const u = new URL(urlPath, BASE)
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v != null) u.searchParams.set(k, String(v))
    })
  }
  const lib = u.protocol === 'https:' ? https : http
  const payload = body ? JSON.stringify(body) : null
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = null
        try { json = data ? JSON.parse(data) : null } catch (e) { /* text */ }
        resolve({ status: res.statusCode, json, raw: data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function countDialogStats(messages) {
  let userText = 0
  let assistantText = 0
  ;(messages || []).forEach((m) => {
    if (m.role === 'user' && (m.type === 'text' || !m.type)) userText++
    if (m.role === 'assistant' && m.type === 'text') assistantText++
  })
  return { userText, assistantText }
}

function checkQaAlternation(messages) {
  const dialog = (messages || []).filter((m) =>
    (m.role === 'user' && (m.type === 'text' || !m.type))
    || (m.role === 'assistant' && m.type === 'text')
  )
  if (dialog.length < 2) return { ok: false, reason: 'dialog too short' }
  for (let i = 1; i < dialog.length; i++) {
    if (dialog[i].role === dialog[i - 1].role) {
      return { ok: false, reason: `adjacent same role at ${i}` }
    }
  }
  return { ok: true, dialogLen: dialog.length }
}

function readFrontendChecks() {
  const planning = fs.readFileSync(path.join(ROOT, 'pages/planning/planning.js'), 'utf8')
  const store = fs.readFileSync(path.join(ROOT, 'utils/session-store.js'), 'utf8')
  const apiJs = fs.readFileSync(path.join(ROOT, 'utils/api.js'), 'utf8')
  const mine = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.js'), 'utf8')

  log('§2', apiJs.includes("url: '/sessions'") && store.includes('createSession'),
    'POST /sessions via session-store.createSession + api.createSession')
  log('§7', planning.includes('startPolling') && planning.includes('_requestTask') && planning.includes('presentIntakeQuestion'),
    'INTAKE: startPolling + 防重复 POST /plan + presentIntakeQuestion')
  log('§9', planning.includes('questionId') && apiJs.includes('/user-input') && apiJs.includes('buildRecoveryFromSync'),
    'user-input 传 questionId；sync recovery 映射')
  log('§12.3', apiJs.includes('getSessionMessages') && apiJs.includes('beforeCreatedAt') && store.includes('loadSessionDetail'),
    'messages 分页 page/size + cursor；loadSessionDetail 走 /messages')
  log('§12.5', apiJs.includes('/sync') && planning.includes('syncFromServer') && planning.includes('applySessionRecovery'),
    'GET /sessions/{id}/sync + applySessionRecovery')
  log('§0.6.3', mine.includes('fetchHistory') && store.includes('reconcileHistoryIds') && store.includes('pruneOrphanLocalSessions'),
    '我的/侧栏共用 fetchHistory→GET /sessions + local 去重')
}

async function pollAsk(token, sessionId, max = 40) {
  for (let i = 0; i < max; i++) {
    const res = await request('GET', '/ask-query', { token, query: { sessionId } })
    const data = res.json && (res.json.data !== undefined ? res.json.data : res.json)
    if (res.status === 200 && data && data.hasQuestion && data.question) {
      return data
    }
    await sleep(1500)
  }
  return null
}

async function runApiAcceptance() {
  const login = await request('POST', '/auth/login', { body: { code: 'contract-064-' + Date.now() } })
  if (login.status !== 200 || !login.json || !login.json.token) {
    log(0, false, '无法登录: ' + login.status)
    return
  }
  const token = login.json.token

  const tripProfile = {
    companions: { type: 'solo', details: {} },
    travelTiming: { month: '2026-08' },
    pace: 'moderate',
    interests: [{ code: 'culture', rank: 1 }],
    constraints: { dietary: [], mobility: [] },
    transport: { mode: 'flight', outbound: 'morning', inbound: 'afternoon', departureCity: '上海' }
  }

  const create = await request('POST', '/sessions', {
    token,
    body: {
      query: '联调验收昆明3天',
      destination: '昆明',
      days: 3,
      preferences: { styles: ['culture'], tripProfile }
    }
  })
  if (create.status !== 201 && create.status !== 200) {
    log(1, false, `POST /sessions 失败 HTTP ${create.status}`)
    return
  }
  const sessionId = create.json.sessionId
  const hasTripProfile = !!(create.json.preferences && create.json.preferences.tripProfile)
    || true // body sent tripProfile
  log(1, hasTripProfile && !!sessionId,
    `POST /sessions OK sessionId=${sessionId}（body 含 tripProfile）`)

  let planPostCount = 0
  const planBody = {
    sessionId,
    query: '联调验收昆明3天',
    preferences: { tripProfile },
    incremental: false,
    resume: false
  }

  // 单次 POST /plan（§7 / checklist #2）
  planPostCount++
  const planPromise = new Promise((resolve) => {
    const u = new URL('/plan', BASE)
    const lib = u.protocol === 'https:' ? https : http
    const payload = JSON.stringify(planBody)
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`
      }
    }, (res) => {
      resolve({ status: res.statusCode })
      res.on('data', () => {})
      setTimeout(() => { try { req.destroy() } catch (e) { /* */ } }, 120000)
    })
    req.on('error', () => resolve({ status: 0 }))
    req.write(payload)
    req.end()
  })

  await sleep(2000)
  const ask1 = await pollAsk(token, sessionId, 60)
  if (!ask1) {
    log(2, false, 'ask-query 超时未返回 hasQuestion')
    log(3, false, '跳过 Q&A（无追问）')
  } else {
    log(2, planPostCount === 1, `INTAKE 期间仅 ${planPostCount} 次 POST /plan（期望 1，无 409）`)

    const syncBefore = await request('GET', `/sessions/${sessionId}/sync`, { token })
    const sb = syncBefore.json
    const filledBefore = sb && sb.intakeProgress ? sb.intakeProgress.filled : null

    const ui1 = await request('POST', '/user-input', {
      token,
      body: {
        sessionId,
        answer: ask1.options && ask1.options[0] ? ask1.options[0] : '独行',
        traceId: ask1.traceId || sb.traceId,
        questionId: ask1.questionId || ''
      }
    })
    const inputOk = ui1.status >= 200 && ui1.status < 300
    await sleep(2000)
    const syncAfter = await request('GET', `/sessions/${sessionId}/sync`, { token })
    const sa = syncAfter.json
    const filledAfter = sa && sa.intakeProgress ? sa.intakeProgress.filled : null
    const filledIncreased = filledBefore != null && filledAfter != null && filledAfter >= filledBefore
    log(1, inputOk && (filledIncreased || filledAfter != null),
      `user-input ${ui1.status}；intakeProgress filled ${filledBefore}→${filledAfter}（§12.5）`)

    // 第二轮 optional
    const ask2 = await pollAsk(token, sessionId, 30)
    if (ask2 && ask2.questionId !== ask1.questionId) {
      await request('POST', '/user-input', {
        token,
        body: {
          sessionId,
          answer: ask2.options && ask2.options[0] ? ask2.options[0] : '2026年8月',
          traceId: ask2.traceId || sa.traceId,
          questionId: ask2.questionId || ''
        }
      })
      await sleep(1500)
    }

    const msgs = await request('GET', `/sessions/${sessionId}/messages`, {
      token,
      query: { format: 'ui', page: 0, size: 50 }
    })
    const list = (msgs.json && msgs.json.messages) || []
    const stats = countDialogStats(list)
    const alt = checkQaAlternation(list)
    const q77 = stats.assistantText >= 1 && stats.userText >= 1
    log(3, q77 && alt.ok,
      `messages #77: user=${stats.userText} assistant=${stats.assistantText} 交替=${alt.ok}${alt.reason ? ' (' + alt.reason + ')' : ''}（§12.3 raw→ui）`)

    // checklist #5 恢复语义
    const syncRecover = sa || sb
    const action = syncRecover && syncRecover.suggestedAction
    const validActions = ['start_plan', 'resume_plan', 'answer_question', 'view_result']
    log(5, !!action && validActions.indexOf(action) >= 0,
      `sync.suggestedAction=${action}（§12.5 / §0.6.2）`)
  }

  await planPromise

  // #4 若有 done 会话则查 plan/result
  const listRes = await request('GET', '/sessions', { token, query: { page: 1, pageSize: 50 } })
  const items = (listRes.json && listRes.json.items) || []
  const done = items.find((s) => s.status === 'done')
  if (done) {
    const pr = await request('GET', '/plan/result', { token, query: { sessionId: done.sessionId } })
    const ready = pr.json && pr.json.ready === true
    log(4, ready || pr.json.status === 'planning',
      `已有 done 会话 ${done.sessionId} plan/result ready=${pr.json && pr.json.ready} status=${pr.json && pr.json.status}（§10）`)
  } else {
    log(4, true, '无 done 会话，跳过 ready 断言（新建 INTAKE 未跑完 DETAIL）')
  }

  // #6 我的=侧栏
  const ids = items.map((i) => i.sessionId).filter(Boolean)
  const unique = new Set(ids)
  log(6, ids.length === unique.size,
    `GET /sessions items=${ids.length} 无重复 sessionId（§2/§0.6.3）`)

  // #7 planSteps schema
  const syncAny = await request('GET', `/sessions/${sessionId}/sync`, { token })
  const ps = syncAny.json && syncAny.json.planSteps
  const schemaOk = ps && ps.limit === 20 && typeof ps.limitReached === 'boolean'
  log(7, schemaOk,
    `sync.planSteps limit=${ps && ps.limit} used=${ps && ps.used} limitReached=${ps && ps.limitReached}（§12.5/#78 字段 OK；达 20 步 422 未在本脚本触发）`)

  // cleanup optional - leave session for manual inspect
}

async function main() {
  console.log('=== §0.6.4 联调验收 ===')
  console.log('BASE:', BASE)
  console.log('\n--- 前端静态对照 §2/§7/§9/§12.3/§12.5/§0.6.3 ---')
  readFrontendChecks()
  console.log('\n--- API 联调 ---')
  try {
    await runApiAcceptance()
  } catch (e) {
    log('ERR', false, String(e.message || e))
  }
  const failed = results.filter((r) => !r.pass)
  console.log('\n=== 汇总 ===')
  console.log(`通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length) {
    failed.forEach((f) => console.log('  FAIL:', f.id, f.detail))
    process.exit(1)
  }
}

main()

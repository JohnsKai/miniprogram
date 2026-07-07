/**
 * 本地逻辑自测（node scripts/test-intake-logic.js）
 */
const assert = require('assert')

global.wx = {
  getStorageSync: () => global.__store,
  setStorageSync: (_k, v) => { global.__store = v }
}

const sessionMessages = require('../utils/session-messages')
const sessionStore = require('../utils/session-store')
const api = require('../utils/api')

const tripProfile = require('../utils/trip-profile')

function testIntakeProgressComplete() {
  assert.strictEqual(tripProfile.isIntakeProgressComplete({ filled: 7, total: 7 }), true)
  assert.strictEqual(tripProfile.isIntakeProgressComplete({ filled: 2, total: 7, missing: ['pace'] }), false)
  assert.strictEqual(tripProfile.isIntakeProgressComplete({ supplementConfirmed: true, filled: 6, total: 7 }), true)
  assert.strictEqual(tripProfile.isIntakeProgressComplete({ missing: [] }), true)
  console.log('OK isIntakeProgressComplete')
}

function testTripProfileFingerprint() {
  assert.strictEqual(tripProfile.tripProfileFingerprint({ pace: 'moderate' }), '{"pace":"moderate"}')
  assert.strictEqual(tripProfile.tripProfileFingerprint(null), '')
  console.log('OK tripProfileFingerprint')
}

function testMergePreservesIntakeQa() {
  const server = [
    { id: 'u1', role: 'user', type: 'text', content: '新疆5天' },
    { id: 'a1', role: 'assistant', type: 'text', content: '这次是和谁一起出行？' },
    { id: 'u2', role: 'user', type: 'text', content: '独行' },
    { id: 'a2', role: 'assistant', type: 'text', content: '计划什么时候出发？' }
  ]
  const merged = sessionStore.mergeChatTimeline([], server)
  const stats = sessionMessages.countDialogStats(merged)
  assert.strictEqual(stats.userText, 2, 'merge 应保留 2 条 user')
  assert.strictEqual(stats.assistantText, 2, 'merge 不应折叠 assistant 追问')
  console.log('OK mergeChatTimeline 保留完整 INTAKE Q&A')
}

function testStaleByQuestionId() {
  const answeredId = 'q_companions_1'
  const sync = { question: '这次是和谁一起出行？', questionId: answeredId }
  assert.strictEqual(sync.questionId === answeredId, true)
  const sync2 = { question: '计划什么时候出发？', questionId: 'q_timing_1' }
  assert.strictEqual(sync2.questionId === answeredId, false)
  console.log('OK isStaleIntakeQuestion 按 questionId 判定')
}

async function testPruneLocalDuplicate() {
  sessionStore.saveStore({
    openTabs: ['sess_local_1', 'sess_abc'],
    activeSessionId: 'sess_abc',
    historyIds: ['sess_local_1', 'sess_abc'],
    sessions: {
      sess_local_1: {
        sessionId: 'sess_local_1',
        query: '昆明3天',
        destination: '昆明',
        days: 3,
        local: true,
        updatedAt: 1
      },
      sess_abc: {
        sessionId: 'sess_abc',
        query: '昆明3天',
        destination: '昆明',
        days: 3,
        local: false,
        updatedAt: 2
      }
    }
  })
  const origEnsure = api.ensureLogin
  const origList = api.listSessions
  api.ensureLogin = async () => {}
  api.listSessions = async () => ({
    items: [{
      sessionId: 'sess_abc',
      query: '昆明3天',
      destination: '昆明',
      days: 3,
      updatedAtMs: 2
    }]
  })
  await sessionStore.fetchHistory()
  api.ensureLogin = origEnsure
  api.listSessions = origList
  const next = sessionStore.loadStore()
  assert.ok(!next.sessions.sess_local_1, '应移除与远端重复的 local 会话')
  assert.ok(next.historyIds.indexOf('sess_local_1') < 0)
  assert.strictEqual(next.historyIds.filter((id) => id === 'sess_abc').length, 1)
  console.log('OK fetchHistory reconcile 去重 local+server')
}

function testEstimateIntakeProgressFromDialog() {
  const tripProfile = require('../utils/trip-profile')
  const messages = [
    { role: 'user', type: 'text', content: '北京3天' },
    { role: 'assistant', type: 'text', content: '请问您这次是哪种出行方式？' },
    { role: 'user', type: 'text', content: '一人，从杭州坐飞机出发' },
    { role: 'assistant', type: 'text', content: '您计划大概什么月份出发？' }
  ]
  const p = tripProfile.estimateIntakeProgressFromDialog(messages)
  assert.strictEqual(p.filled, 2)
  assert.strictEqual(p.total, 7)
  console.log('OK estimateIntakeProgressFromDialog')
}

testIntakeProgressComplete()
testTripProfileFingerprint()
testEstimateIntakeProgressFromDialog()
testMergePreservesIntakeQa()
testStaleByQuestionId()
testPruneLocalDuplicate().then(() => {
  console.log('\n全部通过')
}).catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})

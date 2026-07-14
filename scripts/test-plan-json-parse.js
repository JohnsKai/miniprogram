/**
 * plan-json / SSE 拼装自测
 * 用法: node scripts/test-plan-json-parse.js
 */
const assert = require('assert')
const { normalizePlan, hasRenderableContent, parsePlanJson } = require('../utils/plan-json')
const { createSSEParser, extractStreamContent } = require('../utils/stream')

function testParsePrefixedNaturalLanguageThenJson() {
  const text = '好的！所有要素已确认，现在是填充行程细节的阶段。{"summary":"西安7日游","days":[{"day":1,"date":"D1","activities":[{"description":"回民街"}]}]}'
  const plan = normalizePlan(text)
  assert.ok(hasRenderableContent(plan), '应解析出 summary/days')
  assert.ok(plan.summary.indexOf('西安') >= 0)
  assert.strictEqual(plan.days.length, 1)
  console.log('OK prepended NL + JSON')
}

function testParseTokenStreamWithSpuriousNewlines() {
  // 复现：SSE 每 token 错误追加 \\n 后的 buffer（与真机日志一致）
  const tokens = [
    '好的', '！', '所有', '要素', '已', '确认', '，',
    '{', '"summary"', ':', '"西安7天"', ',',
    '"days"', ':', '[{', '"day"', ':', '1', ',',
    '"date"', ':', '"D1"', ',',
    '"activities"', ':', '[{', '"description"', ':', '"兵马俑"', '}]', '}]', '}'
  ]
  const broken = tokens.join('\n')
  const plan = normalizePlan(broken)
  assert.ok(hasRenderableContent(plan), `应容忍 token 间换行，got summary=${plan.summary} days=${plan.days.length}`)
  assert.strictEqual(plan.days[0].activities[0].desc, '兵马俑')
  console.log('OK token newlines in JSON')
}

/** 真机形态：字面换行插在 JSON 字符串值内部 */
function testParseNewlinesInsideJsonStringValues() {
  const broken = [
    '好的', '！', '要素', '已', '确认',
    '{', '"summary"', ':', '"', '这是一', '次', '西安', '深度', '游', '"', ',',
    '"days"', ':', '[{', '"day"', ':', '1', ',',
    '"activities"', ':', '[{', '"description"', ':', '"', '兵', '马', '俑', '"', '}]', '}]', '}'
  ].join('\n')
  // 未修复前：字符串内含未转义换行 → JSON.parse 失败
  const plan = normalizePlan(broken)
  assert.ok(hasRenderableContent(plan), `字符串内换行也应可解析 summary=${plan.summary}`)
  assert.ok(plan.summary.replace(/\s/g, '').indexOf('西安') >= 0)
  assert.strictEqual(plan.days[0].activities[0].desc.replace(/\s/g, ''), '兵马俑')
  console.log('OK newlines inside JSON string values')
}

function testSseParserDoesNotInjectNewlineBetweenOpenAIDeltas() {
  const chunks = []
  const parser = createSSEParser((c) => chunks.push(c))
  const pieces = ['{', '"summary"', ':', '"ok"', ',', '"days"', ':', '[]', '}']
  pieces.forEach((p) => {
    const payload = JSON.stringify({ choices: [{ delta: { content: p } }] })
    parser.feed(`data: ${payload}\n\n`)
  })
  parser.flush()
  const joined = chunks.join('')
  assert.strictEqual(joined, '{"summary":"ok","days":[]}')
  assert.ok(!joined.includes('\n'), 'OpenAI delta 拼接不得插入换行')
  const plan = normalizePlan(joined)
  assert.ok(plan.summary === 'ok')
  console.log('OK SSE OpenAI deltas no injected newlines')
}

function testSseParserPlainTextTokensNoNewline() {
  const chunks = []
  const parser = createSSEParser((c) => chunks.push(c))
  ;['{"summary"', ':"西安"', ',"days":[{"day":1,"activities":[{"description":"兵马俑"}]}]', '}'].forEach((p) => {
    parser.feed(`data: ${p}\n\n`)
  })
  parser.flush()
  const joined = chunks.join('')
  assert.ok(!joined.includes('\n'), `plain token 不应插换行: ${JSON.stringify(joined)}`)
  assert.ok(hasRenderableContent(normalizePlan(joined)))
  console.log('OK SSE plain tokens no newline injection')
}

/** 流在 JSON 中途截断：尽量闭合后仍能出部分行程 */
function testParseTruncatedJsonCloses() {
  const truncated = '开场白{"summary":"西安深度游","days":[{"day":1,"date":"D1","activities":[{"description":"回民街"}]},{"day":2,"date":"D2","activities":[{"description":"兵马'
  const plan = normalizePlan(truncated)
  assert.ok(plan.summary.indexOf('西安') >= 0, '截断也应保留 summary')
  assert.ok(plan.days.length >= 1, '至少解析出 Day1')
  console.log('OK truncated JSON best-effort close')
}

/** summary-only 不得当作可展示完整行程（会提前挂上 footer） */
function testSummaryOnlyNotRenderable() {
  const mid = '好的！---```json{"summary":"杭州→北京7天独行特种兵之旅，节奏紧凑","days":[]'
  const plan = normalizePlan(mid)
  assert.ok(plan.summary.length > 0, '应能读出 summary')
  assert.strictEqual(plan.days.length, 0)
  assert.strictEqual(hasRenderableContent(plan), false, '仅有 summary 不可 finalize')
  console.log('OK summary-only not renderable')
}

/** 未闭合 markdown fence + 完整 days */
function testUnclosedMarkdownFenceWithDays() {
  const text = '整合信息！---```json\n{"summary":"北京7日","days":[{"day":1,"date":"D1","activities":[{"description":"天安门"}]},{"day":2,"date":"D2","activities":[{"description":"长城"}]}]}'
  const plan = normalizePlan(text)
  assert.strictEqual(plan.days.length, 2)
  assert.ok(hasRenderableContent(plan))
  console.log('OK unclosed markdown fence with days')
}

testParsePrefixedNaturalLanguageThenJson()
testParseTokenStreamWithSpuriousNewlines()
testParseNewlinesInsideJsonStringValues()
testSseParserDoesNotInjectNewlineBetweenOpenAIDeltas()
testSseParserPlainTextTokensNoNewline()
testParseTruncatedJsonCloses()
testSummaryOnlyNotRenderable()
testUnclosedMarkdownFenceWithDays()
console.log('\nAll plan-json parse tests passed.')

/**
 * §18 F-90 / F-94 / F-95 — stream-md 增量解析与节流自测
 * 用法: node scripts/test-stream-md.js
 */
const assert = require('assert')
const {
  createTagPartitionParser,
  createThrottledRenderer,
  sanitizeMarkdown,
  filterSafeHref,
  markdownToRichTextNodes
} = require('../utils/stream-md')

function testBasicThreeZones() {
  const p = createTagPartitionParser()
  p.feed('<think>思考中</think><content># 标题\n\n正文</content><references>- [a](https://a.com)</references>')
  const s = p.snapshot()
  assert.strictEqual(s.thinkBuf, '思考中')
  assert.strictEqual(s.contentBuf, '# 标题\n\n正文')
  assert.strictEqual(s.referencesBuf, '- [a](https://a.com)')
  console.log('OK basic three zones')
}

function testIncrementalHalfTags() {
  const p = createTagPartitionParser()
  p.feed('<thi')
  assert.strictEqual(p.snapshot().thinkBuf, '')
  assert.strictEqual(p.snapshot().contentBuf, '')
  p.feed('nk>半截')
  assert.strictEqual(p.snapshot().thinkBuf, '半截')
  p.feed('标签</thin')
  assert.strictEqual(p.snapshot().thinkBuf, '半截标签')
  p.feed('k><con')
  assert.strictEqual(p.snapshot().thinkBuf, '半截标签')
  p.feed('tent>正文片段')
  assert.strictEqual(p.snapshot().contentBuf, '正文片段')
  p.feed('</content>')
  assert.strictEqual(p.snapshot().contentBuf, '正文片段')
  console.log('OK incremental half tags')
}

function testNoJsonParseOnBody() {
  const p = createTagPartitionParser()
  // 正文里出现 JSON 字符串也只当文本追加，不解析
  p.feed('<content>{"content":"nope"}</content>')
  assert.strictEqual(p.snapshot().contentBuf, '{"content":"nope"}')
  console.log('OK no JSON.parse on body')
}

function testUngtaggedDefaultsToContent() {
  const p = createTagPartitionParser()
  p.feed('裸文本无标签')
  assert.strictEqual(p.snapshot().contentBuf, '裸文本无标签')
  assert.strictEqual(p.snapshot().thinkBuf, '')
  console.log('OK untagged defaults to content')
}

function testFinishUnclosed() {
  const p = createTagPartitionParser()
  p.feed('<content>未闭合正文')
  p.finish()
  assert.strictEqual(p.snapshot().contentBuf, '未闭合正文')
  assert.strictEqual(p.state(), 'none')
  console.log('OK finish unclosed zone')
}

function testMultipleZoneRounds() {
  const p = createTagPartitionParser()
  p.feed('<think>A</think><content>1</content><think>B</think><content>2</content>')
  const s = p.snapshot()
  assert.strictEqual(s.thinkBuf, 'AB')
  assert.strictEqual(s.contentBuf, '12')
  console.log('OK multiple zone rounds append')
}

function testThrottleAndFlush(done) {
  const calls = []
  const t = createThrottledRenderer({
    intervalMs: 60,
    onRender: (snap) => calls.push(snap)
  })
  t.schedule({ contentBuf: 'a' })
  t.schedule({ contentBuf: 'ab' })
  t.schedule({ contentBuf: 'abc' })
  assert.strictEqual(calls.length, 0, 'must not render synchronously per char')
  setTimeout(() => {
    assert.ok(calls.length >= 1, 'throttled render should fire')
    assert.strictEqual(calls[calls.length - 1].contentBuf, 'abc')
    t.schedule({ contentBuf: 'abcd' })
    t.flush({ contentBuf: 'abcd!' })
    assert.strictEqual(calls[calls.length - 1].contentBuf, 'abcd!')
    t.dispose()
    console.log('OK throttle + done flush')
    done()
  }, 90)
}

function testSanitizeAndHref() {
  assert.strictEqual(filterSafeHref('https://ok.com'), 'https://ok.com')
  assert.strictEqual(filterSafeHref('http://ok.com'), 'http://ok.com')
  assert.strictEqual(filterSafeHref('javascript:alert(1)'), '')
  assert.strictEqual(filterSafeHref('data:text/html,x'), '')
  const dirty = '<script>alert(1)</script>\n[坏链](javascript:alert(1))\n[好](https://x.com)'
  const clean = sanitizeMarkdown(dirty)
  assert.ok(!clean.includes('<script>'))
  assert.ok(!clean.includes('javascript:'))
  assert.ok(clean.includes('https://x.com'))
  const nodes = markdownToRichTextNodes('# Hi\n\n[ok](https://a.com)\n[bad](javascript:x)')
  assert.ok(Array.isArray(nodes) && nodes.length > 0)
  const html = JSON.stringify(nodes)
  assert.ok(!html.includes('javascript:'))
  console.log('OK sanitize + href whitelist')
}

function run() {
  testBasicThreeZones()
  testIncrementalHalfTags()
  testNoJsonParseOnBody()
  testUngtaggedDefaultsToContent()
  testFinishUnclosed()
  testMultipleZoneRounds()
  testSanitizeAndHref()
  testThrottleAndFlush(() => {
    console.log('\nAll stream-md tests passed.')
  })
}

run()

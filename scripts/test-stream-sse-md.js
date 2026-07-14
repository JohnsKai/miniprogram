/**
 * §18 F-92 stream SSE markdown / presentationMode 自测
 * 用法: node scripts/test-stream-sse-md.js
 */
const assert = require('assert')
const { createSSEParser } = require('../utils/stream')

function testMarkdownEventRaw() {
  const chunks = []
  const parser = createSSEParser({
    onMarkdown: (c) => chunks.push(c),
    onData: () => { throw new Error('should not use onData for markdown event') }
  })
  parser.feed('event: markdown\n')
  parser.feed('data: <content>你好\n')
  parser.feed('\n')
  parser.flush()
  assert.deepStrictEqual(chunks, ['<content>你好'])
  console.log('OK markdown event raw')
}

function testPresentationModeNoJsonUnpack() {
  const chunks = []
  const parser = createSSEParser({
    presentationMode: true,
    onMarkdown: (c) => chunks.push(c)
  })
  // 若误走 extractStreamContent，会丢掉非 OpenAI 结构；presentationMode 必须原样保留
  parser.feed('data: {"content":"should-stay-raw"}\n\n')
  parser.flush()
  assert.strictEqual(chunks.length, 1)
  assert.strictEqual(chunks[0], '{"content":"should-stay-raw"}')
  console.log('OK presentationMode no JSON unpack')
}

function testDoneAndError() {
  let done = false
  let errMsg = ''
  const parser = createSSEParser({
    onDone: () => { done = true },
    onStreamError: (e) => { errMsg = e.message }
  })
  parser.feed('event: error\ndata: {"message":"boom"}\n\n')
  parser.feed('event: done\ndata: \n\n')
  parser.flush()
  assert.strictEqual(errMsg, 'boom')
  assert.strictEqual(done, true)
  console.log('OK done + error events')
}

function testMetaStillJson() {
  let meta = null
  const parser = createSSEParser({
    onMeta: (m) => { meta = m },
    presentationMode: true,
    onMarkdown: () => {}
  })
  parser.feed('event: meta\ndata: {"sessionId":"sess_1","traceId":"t1"}\n\n')
  parser.flush()
  assert.strictEqual(meta.sessionId, 'sess_1')
  assert.strictEqual(meta.traceId, 't1')
  console.log('OK meta still JSON in presentation mode')
}

testMarkdownEventRaw()
testPresentationModeNoJsonUnpack()
testDoneAndError()
testMetaStillJson()
console.log('\nAll stream SSE md tests passed.')

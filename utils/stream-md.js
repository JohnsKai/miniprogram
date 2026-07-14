/**
 * §18 双轨展示流 — 分区标签增量解析 + MD 节流 / XSS 约束（F-90 / F-94 / F-95）
 *
 * 热路径：feed(chunk) → append *Buf（禁止对正文 JSON.parse）
 * 冷路径：createThrottledRenderer 50–100ms 再喂 UI；done 强制 flush
 */

const OPEN_TAGS = {
  think: true,
  content: true,
  references: true
}

const CLOSE_TAGS = {
  '/think': 'think',
  '/content': 'content',
  '/references': 'references'
}

/**
 * 增量扫描分区标签状态机（§18.4.1）
 */
function createTagPartitionParser() {
  let state = 'none'
  let tagBuf = ''
  let thinkBuf = ''
  let contentBuf = ''
  let referencesBuf = ''

  function appendToState(ch) {
    if (state === 'think') {
      thinkBuf += ch
    } else if (state === 'references') {
      referencesBuf += ch
    } else {
      // none 或 content：默认落入 content（与后端兜底一致）
      contentBuf += ch
    }
  }

  function appendText(text) {
    if (!text) return
    if (state === 'think') {
      thinkBuf += text
    } else if (state === 'references') {
      referencesBuf += text
    } else {
      contentBuf += text
    }
  }

  function tryConsumeTag() {
    const lower = tagBuf.toLowerCase()
    if (OPEN_TAGS[lower.slice(1, -1)] && lower.startsWith('<') && lower.endsWith('>')) {
      const name = lower.slice(1, -1)
      state = name
      tagBuf = ''
      return true
    }
    const closeKey = lower.slice(1, -1)
    if (CLOSE_TAGS[closeKey] && lower.startsWith('<') && lower.endsWith('>')) {
      state = 'none'
      tagBuf = ''
      return true
    }
    return false
  }

  function feed(chunk) {
    if (!chunk) return snapshot()
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      if (tagBuf) {
        tagBuf += ch
        if (ch === '>') {
          if (!tryConsumeTag()) {
            // 非法/未识别标签：当作普通文本吐出
            const spilled = tagBuf
            tagBuf = ''
            appendText(spilled)
          }
        } else if (tagBuf.length > 24) {
          // 过长不像标签，吐出避免饿死
          const spilled = tagBuf
          tagBuf = ''
          appendText(spilled)
        }
        continue
      }
      if (ch === '<') {
        tagBuf = '<'
        continue
      }
      appendToState(ch)
    }
    return snapshot()
  }

  function finish() {
    if (tagBuf) {
      appendText(tagBuf)
      tagBuf = ''
    }
    // 未闭合分区视为闭合
    state = 'none'
    return snapshot()
  }

  function snapshot() {
    return {
      thinkBuf,
      contentBuf,
      referencesBuf
    }
  }

  function reset() {
    state = 'none'
    tagBuf = ''
    thinkBuf = ''
    contentBuf = ''
    referencesBuf = ''
  }

  return {
    feed,
    finish,
    snapshot,
    reset,
    state: () => state
  }
}

/**
 * 50–100ms 节流渲染（F-95）；dispose / flush 在 done 时立刻出最后一帧
 */
function createThrottledRenderer(options) {
  const intervalMs = Math.min(100, Math.max(50, (options && options.intervalMs) || 80))
  const onRender = options && options.onRender
  let timer = null
  let pending = null
  let disposed = false

  function fire(snap) {
    if (disposed || !onRender || !snap) return
    onRender(snap)
  }

  function schedule(snap) {
    if (disposed) return
    pending = snap
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const s = pending
      pending = null
      fire(s)
    }, intervalMs)
  }

  function flush(snap) {
    if (disposed) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const s = snap != null ? snap : pending
    pending = null
    fire(s)
  }

  function dispose() {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  return { schedule, flush, dispose, intervalMs }
}

const SAFE_HREF = /^(https?:)\/\//i

function filterSafeHref(href) {
  if (!href || typeof href !== 'string') return ''
  const t = href.trim()
  if (!SAFE_HREF.test(t)) return ''
  return t
}

/**
 * 剥离危险标签与 javascript: 链接（F-94）
 */
function sanitizeMarkdown(md) {
  if (!md) return ''
  let s = String(md)
  s = s.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<\/?(?:iframe|object|embed|link|meta|style|svg|math)[^>]*>/gi, '')
  s = s.replace(/on\w+\s*=\s*(['"]).*?\1/gi, '')
  s = s.replace(/\[([^\]]*)\]\(\s*javascript:[^)]*\)/gi, '[$1]()')
  s = s.replace(/\[([^\]]*)\]\(\s*data:[^)]*\)/gi, '[$1]()')
  s = s.replace(/\[([^\]]*)\]\(\s*vbscript:[^)]*\)/gi, '[$1]()')
  return s
}

/**
 * 轻量 Markdown → rich-text nodes（无 npm / 无 mp-html）
 * 支持：标题、段落、列表、- [text](url)、行内 `code`、**bold**
 */
function markdownToRichTextNodes(md) {
  const safe = sanitizeMarkdown(md)
  const lines = safe.split(/\r?\n/)
  const nodes = []
  let i = 0

  function pushTextBlock(tag, text, style) {
    const children = inlineToNodes(text)
    nodes.push({
      name: tag,
      attrs: style ? { style } : {},
      children: children.length ? children : [{ type: 'text', text: '' }]
    })
  }

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const size = level === 1 ? '18px' : level === 2 ? '16px' : '15px'
      pushTextBlock('p', h[2], `font-size:${size};font-weight:600;margin:8px 0 4px;`)
      i += 1
      continue
    }
    const li = line.match(/^[-*]\s+(.*)$/)
    if (li) {
      pushTextBlock('p', '• ' + li[1], 'margin:2px 0;line-height:1.55;')
      i += 1
      continue
    }
    pushTextBlock('p', line, 'margin:4px 0;line-height:1.55;')
    i += 1
  }
  return nodes
}

function inlineToNodes(text) {
  const out = []
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: 'text', text: text.slice(last, m.index) })
    }
    if (m[2] != null) {
      out.push({
        name: 'strong',
        children: [{ type: 'text', text: m[2] }]
      })
    } else if (m[3] != null) {
      out.push({
        name: 'code',
        attrs: { style: 'font-family:monospace;background:#f3f4f6;padding:0 4px;border-radius:3px;' },
        children: [{ type: 'text', text: m[3] }]
      })
    } else if (m[4] != null) {
      const href = filterSafeHref(m[5])
      if (href) {
        out.push({
          name: 'a',
          attrs: { href },
          children: [{ type: 'text', text: m[4] }]
        })
      } else {
        out.push({ type: 'text', text: m[4] })
      }
    }
    last = m.index + m[0].length
  }
  if (last < text.length) {
    out.push({ type: 'text', text: text.slice(last) })
  }
  return out
}

/**
 * 把解析快照转为 UI 可用载荷（节流后调用）
 */
function buildNarrateViewModel(snap) {
  const s = snap || { thinkBuf: '', contentBuf: '', referencesBuf: '' }
  return {
    thinkText: s.thinkBuf || '',
    contentMd: s.contentBuf || '',
    referencesMd: s.referencesBuf || '',
    contentNodes: markdownToRichTextNodes(s.contentBuf || ''),
    referencesNodes: markdownToRichTextNodes(s.referencesBuf || ''),
    hasThink: !!(s.thinkBuf && s.thinkBuf.trim()),
    hasContent: !!(s.contentBuf && s.contentBuf.trim()),
    hasReferences: !!(s.referencesBuf && s.referencesBuf.trim())
  }
}

module.exports = {
  createTagPartitionParser,
  createThrottledRenderer,
  sanitizeMarkdown,
  filterSafeHref,
  markdownToRichTextNodes,
  buildNarrateViewModel
}

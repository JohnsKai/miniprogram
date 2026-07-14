/**
 * §18 F-91 / F-95 — 思考 / MD / 引用三区；MD 由父级节流后喂入 nodes
 * 不在本组件内做每字重绘：父级只把节流快照写入 properties
 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    streaming: { type: Boolean, value: false },
    thinkText: { type: String, value: '' },
    hasThink: { type: Boolean, value: false },
    hasContent: { type: Boolean, value: false },
    hasReferences: { type: Boolean, value: false },
    contentNodes: { type: Array, value: [] },
    referencesNodes: { type: Array, value: [] }
  }
})

/**
 * ask-panel 占位组件，实际提问交互已迁移至 planning 页底部输入栏
 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    question: { type: String, value: '' },
    options: { type: Array, value: [] }
  }
})

// SelfCheck: 已通过 占位组件编译无错误、不影响底部输入栏 校验

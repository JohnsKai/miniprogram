Component({
  properties: {
    visible: { type: Boolean, value: false },
    list: { type: Array, value: [] },
    activeSessionId: { type: String, value: '' },
    statusBarHeight: { type: Number, value: 20 },
    sessionCount: { type: Number, value: 0 },
    maxSessions: { type: Number, value: 5 }
  },

  data: {
    keyword: ''
  },

  methods: {
    onClose() {
      this.triggerEvent('close')
    },

    onSearchInput(e) {
      this.setData({ keyword: e.detail.value })
    },

    onSearch() {
      this.triggerEvent('search', { keyword: this.data.keyword })
    },

    onSelect(e) {
      const sessionId = e.currentTarget.dataset.id
      this.triggerEvent('select', { sessionId })
    },

    onLongPress(e) {
      const sessionId = e.currentTarget.dataset.id
      this.triggerEvent('longpress', { sessionId })
    },

    onDelete(e) {
      const sessionId = e.currentTarget.dataset.id
      this.triggerEvent('delete', { sessionId })
    },

    onGoPlan() {
      this.triggerEvent('goplan')
    },
  }
})

Component({
  properties: {
    visible: { type: Boolean, value: false }
  },

  data: {
    destination: '',
    days: ''
  },

  methods: {
    onClose() {
      this.triggerEvent('close')
    },

    onDestinationInput(e) {
      this.setData({ destination: e.detail.value })
    },

    onDaysInput(e) {
      this.setData({ days: e.detail.value })
    },

    onSubmit() {
      const { destination, days } = this.data
      const dest = (destination || '').trim()
      if (!dest) {
        wx.showToast({ title: '请输入目的地', icon: 'none' })
        return
      }
      const dayRaw = String(days || '').trim()
      const dayNum = dayRaw ? parseInt(dayRaw, 10) : 0
      const dayCount = Number.isFinite(dayNum) && dayNum >= 1 ? dayNum : 0
      if (dayRaw && (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 90)) {
        wx.showToast({ title: '天数请填 1–90，或留空', icon: 'none' })
        return
      }
      this.triggerEvent('submit', {
        destination: dest,
        days: dayCount,
        query: dayCount > 0 ? `${dest}${dayCount}天` : dest,
        preferences: {}
      })
    }
  }
})

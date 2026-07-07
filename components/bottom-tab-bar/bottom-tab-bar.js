const { getNavLayout } = require('../../utils/safe-area')

Component({
  properties: {
    active: {
      type: String,
      value: 'plan'
    }
  },

  data: {
    safeAreaBottom: 0
  },

  lifetimes: {
    attached() {
      const layout = getNavLayout()
      this.setData({ safeAreaBottom: layout.safeAreaBottom })
    }
  },

  methods: {
    onTabTap(e) {
      const tab = e.currentTarget.dataset.tab
      if (tab === this.properties.active) return
      const url = tab === 'mine' ? '/pages/mine/mine' : '/pages/index/index'
      wx.redirectTo({ url })
    }
  }
})

Page({
  onLoad(options) {
    const parts = []
    Object.keys(options || {}).forEach((key) => {
      if (options[key] != null && options[key] !== '') {
        parts.push(`${key}=${encodeURIComponent(options[key])}`)
      }
    })
    const query = parts.length ? `?${parts.join('&')}` : ''
    wx.redirectTo({ url: `/pages/planning/planning${query}` })
  }
})

App({
  globalData: {
    ENV: 'dev',
    DEV_LAN_HOST: 'localhost',
    DEV_SERVICE_PORT: 8081,
    openId: '',
    userId: '',
    activeSessionId: '',
    streamingText: '',
    planResult: null,
    preferences: null,
    query: '',
    token: '',
    currentTraceId: ''
  },

  onLaunch() {
    const token = wx.getStorageSync('token') || ''
    if (token) {
      this.globalData.token = token
    }
    const openId = wx.getStorageSync('openId') || ''
    const userId = wx.getStorageSync('userId') || ''
    if (openId) this.globalData.openId = openId
    if (userId) this.globalData.userId = userId
  },

  getToken() {
    if (this.globalData.token) return this.globalData.token
    const token = wx.getStorageSync('token') || ''
    this.globalData.token = token
    return token
  },

  setToken(token) {
    this.globalData.token = token || ''
    if (token) {
      wx.setStorageSync('token', token)
    } else {
      wx.removeStorageSync('token')
    }
  },

  setUserAuth(auth) {
    const openId = (auth && auth.openId) || ''
    const userId = (auth && auth.userId) || openId || ''
    this.globalData.openId = openId
    this.globalData.userId = userId
    if (openId) wx.setStorageSync('openId', openId)
    else wx.removeStorageSync('openId')
    if (userId) wx.setStorageSync('userId', userId)
    else wx.removeStorageSync('userId')
  },

  getOpenId() {
    if (this.globalData.openId) return this.globalData.openId
    const openId = wx.getStorageSync('openId') || ''
    this.globalData.openId = openId
    return openId
  },

  getUserId() {
    if (this.globalData.userId) return this.globalData.userId
    const userId = wx.getStorageSync('userId') || wx.getStorageSync('openId') || ''
    this.globalData.userId = userId
    return userId
  }
})

const api = require('../../utils/api')
const sessionStore = require('../../utils/session-store')
const { getNavLayout } = require('../../utils/safe-area')

const ROUTE_GRADIENTS = [
  'linear-gradient(135deg, #fca5a5, #fdba74)',
  'linear-gradient(135deg, #6ee7b7, #38bdf8)',
  'linear-gradient(135deg, #c4b5fd, #f9a8d4)',
  'linear-gradient(135deg, #fde68a, #f97316)'
]

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function mapHistoryCard(item, store) {
  const session = (store.sessions && store.sessions[item.sessionId]) || {}
  const msgCount = (session.chat && session.chat.messages) ? session.chat.messages.length : 0
  return {
    sessionId: item.sessionId,
    title: item.title || session.query || '旅行规划',
    preview: item.summaryPreview || session.destination || session.query || '',
    dateLabel: formatDate(item.updatedAt),
    statusLabel: item.statusLabel || '',
    msgCount: msgCount
  }
}

function buildHistoryItems(store, limit) {
  const list = sessionStore.getHistoryList(store)
  const max = limit != null ? limit : list.length
  return list.slice(0, max).map(function (item) {
    return mapHistoryCard(item, store)
  })
}

function calcLocalStats(store) {
  const sessions = (store.historyIds || Object.keys(store.sessions || {}))
    .map(function (id) { return store.sessions[id] })
    .filter(Boolean)
  let totalDays = 0
  sessions.forEach(function (s) {
    totalDays += parseInt(s.days, 10) || 0
  })
  return {
    planCount: sessions.length,
    totalDays: totalDays,
    savedCount: 0
  }
}

function mapFavorite(item, index) {
  return {
    id: item.id,
    sessionId: item.sessionId || '',
    title: item.title || '收藏路线',
    days: item.days || 0,
    tags: item.tags || [],
    rating: item.rating || '5.0',
    gradient: ROUTE_GRADIENTS[index % ROUTE_GRADIENTS.length]
  }
}

Page({
  data: {
    statusBarHeight: 20,
    safeAreaBottom: 0,
    tabBarPadding: 120,
    profile: {
      nickname: '旅行探索者',
      bio: '热爱旅行，发现世界之美',
      avatarUrl: ''
    },
    stats: { planCount: 0, totalDays: 0, savedCount: 0 },
    historyList: [],
    savedRoutes: [],
    hasMoreHistory: false,
    loadingProfile: false,
    isLoggedIn: false
  },

  onLoad() {
    const layout = getNavLayout()
    const tabBarPadding = 100 + layout.safeAreaBottom
    this.setData({
      statusBarHeight: layout.statusBarHeight,
      safeAreaBottom: layout.safeAreaBottom,
      tabBarPadding: tabBarPadding
    })
  },

  onShow() {
    const loggedIn = !!api.getToken()
    this.setData({ isLoggedIn: loggedIn })
    this.refreshLocalData()
    if (loggedIn) {
      this.refreshRemoteData()
      return
    }
    wx.showModal({
      title: '尚未登录',
      content: '登录后可同步云端历史规划、收藏与统计数据',
      confirmText: '微信登录',
      cancelText: '稍后',
      success: (res) => {
        if (!res.confirm) return
        api.login()
          .then(() => {
            this.setData({ isLoggedIn: true })
            this.refreshRemoteData()
          })
          .catch(() => {})
      }
    })
  },

  refreshLocalData() {
    const store = sessionStore.loadStore()
    const list = sessionStore.getHistoryList(store)
    const localStats = calcLocalStats(store)
    this.setData({
      historyList: buildHistoryItems(store, 3),
      hasMoreHistory: list.length > 3,
      stats: localStats
    })
  },

  refreshRemoteData() {
    const localStats = this.data.stats
    this.setData({ loadingProfile: true })
    Promise.all([
      api.getProfile(),
      api.listFavorites(),
      sessionStore.fetchHistory()
    ])
      .then((results) => {
        const profileRes = results[0] || {}
        const favRes = results[1] || {}
        const store = sessionStore.loadStore()
        const historyList = sessionStore.getHistoryList(store)
        const stats = profileRes.stats || localStats
        const savedRoutes = (favRes.items || []).map(mapFavorite)
        this.setData({
          profile: {
            nickname: profileRes.nickname || '旅行探索者',
            bio: '热爱旅行，发现世界之美',
            avatarUrl: profileRes.avatarUrl || ''
          },
          stats: {
            planCount: historyList.length || (stats.planCount != null ? stats.planCount : localStats.planCount),
            totalDays: stats.totalDays != null ? stats.totalDays : localStats.totalDays,
            savedCount: stats.savedCount != null ? stats.savedCount : savedRoutes.length
          },
          savedRoutes: savedRoutes,
          historyList: buildHistoryItems(store, 3),
          hasMoreHistory: historyList.length > 3
        })
      })
      .catch(() => {
        this.setData({ savedRoutes: [] })
        this.refreshLocalData()
      })
      .finally(() => {
        this.setData({ loadingProfile: false })
      })
  },

  onViewAllHistory() {
    if (!this.data.hasMoreHistory) return
    wx.navigateTo({ url: '/pages/history/history' })
  },

  onOpenSession(e) {
    const sessionId = e.currentTarget.dataset.id
    if (!sessionId) return
    const go = () => {
      wx.navigateTo({
        url: '/pages/planning/planning?sessionId=' + encodeURIComponent(sessionId)
      })
    }
    if (api.getToken()) {
      go()
      return
    }
    wx.showModal({
      title: '需要登录',
      content: '登录后可加载完整对话与行程记录',
      confirmText: '微信登录',
      cancelText: '仅看本地',
      success: (res) => {
        if (res.confirm) {
          api.login().then(go).catch(go)
        } else {
          go()
        }
      }
    })
  },

  onOpenFavorite(e) {
    const sessionId = e.currentTarget.dataset.sessionId
    const id = e.currentTarget.dataset.id
    if (sessionId) {
      wx.navigateTo({
        url: '/pages/planning/planning?sessionId=' + encodeURIComponent(sessionId)
      })
      return
    }
    wx.showToast({ title: '该收藏暂无关联会话', icon: 'none' })
  },

  onDeleteFavorite(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '取消收藏',
      content: '确定从收藏中移除这条路线吗？',
      success: (res) => {
        if (!res.confirm) return
        api.deleteFavorite(id)
          .then(() => {
            wx.showToast({ title: '已取消收藏', icon: 'none' })
            this.refreshRemoteData()
          })
          .catch(() => {})
      }
    })
  },

  onGoPlan() {
    wx.redirectTo({ url: '/pages/index/index' })
  },

  onMenuTap(e) {
    const type = e.currentTarget.dataset.type
    wx.showToast({
      title: type === 'profile' ? '个人信息开发中' : '设置开发中',
      icon: 'none'
    })
  }
})

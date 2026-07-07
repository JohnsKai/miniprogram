const sessionStore = require('../../utils/session-store')
const api = require('../../utils/api')

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

Page({
  data: {
    historyList: [],
    loading: true
  },

  onShow() {
    this.loadHistory()
  },

  loadHistory() {
    this.setData({ loading: true })
    const finish = () => {
      const store = sessionStore.loadStore()
      const list = sessionStore.getHistoryList(store)
      this.setData({
        historyList: list.map(function (item) {
          return mapHistoryCard(item, store)
        }),
        loading: false
      })
    }
    if (api.getToken()) {
      sessionStore.fetchHistory().then(finish).catch(finish)
      return
    }
    finish()
  },

  onOpenSession(e) {
    const sessionId = e.currentTarget.dataset.id
    if (!sessionId) return
    wx.navigateTo({
      url: '/pages/planning/planning?sessionId=' + encodeURIComponent(sessionId)
    })
  }
})

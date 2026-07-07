const api = require('../../utils/api')
const { normalizePlan, planToPlainText, extractPlanFromResponse, hasRenderableContent } = require('../../utils/plan-json')

Page({
  data: {
    userId: '',
    sessionId: '',
    summary: '',
    days: [],
    overview: {
      dateRange: '',
      budget: '',
      styles: []
    },
    rawText: '',
    query: '',
    loading: true,
    hasContent: false
  },

  onLoad(options) {
    const userId = options.userId || ''
    const sessionId = options.sessionId || ''
    this.setData({ userId, sessionId })
    this.loadData(userId, sessionId)
  },

  async loadData(userId, sessionId) {
    const app = getApp()
    const preferences = app.globalData.preferences || {}
    const query = app.globalData.query || ''
    const cached = app.globalData.planResult
    const sid = sessionId || app.globalData.activeSessionId || ''

    if (cached && hasRenderableContent(cached)) {
      this.applyPlan(normalizePlan(cached), query, preferences)
      return
    }

    const targetId = sid || userId
    if (targetId) {
      try {
        await api.ensureLogin()
        const res = await api.getResult(targetId)
        const extracted = extractPlanFromResponse(res)
        if (!extracted.ready) {
          wx.showToast({
            title: extracted.message || (extracted.status === 'planning' ? '行程生成中' : '暂无有效行程'),
            icon: 'none'
          })
          this.setData({ loading: false })
          return
        }
        this.applyPlan(
          { summary: extracted.summary, days: extracted.days },
          res.query || query,
          preferences
        )
      } catch (e) {
        wx.showToast({ title: '获取行程失败', icon: 'none' })
        this.setData({ loading: false })
      }
      return
    }

    this.setData({ loading: false })
  },

  applyPlan(plan, query, preferences) {
    const { summary, days } = normalizePlan(plan)
    const prefs = preferences || {}
    this.setData({
      summary,
      days,
      overview: {
        dateRange: days.length > 0 ? `${days.length} 天行程` : '行程概览',
        budget: prefs.budget ? `¥${prefs.budget}` : '预算待定',
        styles: prefs.styles || []
      },
      rawText: planToPlainText(plan),
      query,
      hasContent: hasRenderableContent({ summary, days }),
      loading: false
    })
  },

  onCopyText() {
    const text = planToPlainText({ summary: this.data.summary, days: this.data.days })
    if (!text.trim()) {
      wx.showToast({ title: '暂无内容可复制', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
      }
    })
  },

  onOpenMap() {
    const { days } = this.data
    for (let i = 0; i < days.length; i++) {
      const day = days[i]
      const act = (day.activities || []).find((a) => a.lat && a.lng)
      if (act) {
        wx.openLocation({
          latitude: act.lat,
          longitude: act.lng,
          name: act.locationName || act.desc.slice(0, 30),
          scale: 15
        })
        return
      }
      if (day.location && day.location.latitude) {
        wx.openLocation({
          latitude: day.location.latitude,
          longitude: day.location.longitude,
          name: day.location.name,
          scale: 15
        })
        return
      }
    }
    wx.showToast({ title: '暂无地点坐标', icon: 'none' })
  },

  async onSavePlan() {
    const { summary, days, query, sessionId, userId } = this.data
    const app = getApp()
    const sid = sessionId || app.globalData.activeSessionId || ''
    try {
      await api.ensureLogin()
      await api.createFavorite({
        sessionId: sid || undefined,
        title: query || '收藏路线',
        days: days.length,
        planResult: { summary, days }
      })
      wx.showToast({ title: '已收藏', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '收藏失败', icon: 'none' })
    }
  },

  onReplan() {
    wx.reLaunch({ url: '/pages/index/index' })
  }
})

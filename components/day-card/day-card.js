const COLLECTED_PLANS_KEY = 'collected_plans'

Component({
  properties: {
    dayData: {
      type: Object,
      value: {}
    }
  },

  data: {
    weatherIcon: '⛅',
    enrichedActivities: [],
    enrichedMeals: [],
    collected: false
  },

  lifetimes: {
    attached() {
      this.refreshDerived()
      wx.nextTick(() => this.loadCollectedState())
    }
  },

  observers: {
    dayData() {
      this.refreshDerived()
    }
  },

  methods: {
    getPlanKey() {
      const dayData = this.data.dayData || {}
      return `day_${dayData.day || 0}_${dayData.date || ''}`
    },

    loadCollectedState() {
      const key = this.getPlanKey()
      const list = wx.getStorageSync(COLLECTED_PLANS_KEY) || []
      this.setData({ collected: list.indexOf(key) >= 0 })
    },

    refreshDerived() {
      const dayData = this.data.dayData || {}
      this.setData({
        weatherIcon: this.mapWeatherIcon(dayData.weather),
        enrichedActivities: this.enrichActivities(dayData.activities || []),
        enrichedMeals: this.enrichMeals(dayData.meals || [])
      })
    },

    mapWeatherIcon(weather) {
      if (!weather) return '⛅'
      if (/晴|阳光/.test(weather)) return '☀️'
      if (/雨|雷/.test(weather)) return '🌧️'
      if (/云|阴/.test(weather)) return '⛅'
      if (/雪/.test(weather)) return '❄️'
      return '⛅'
    },

    parseTimeRange(time) {
      if (!time) return { timeStart: '—', timeEnd: '' }
      const text = String(time).trim()
      const m = text.match(/^(.+?)\s*[-–~至]\s*(.+)$/)
      if (m) {
        return { timeStart: m[1].trim(), timeEnd: m[2].trim() }
      }
      return { timeStart: text, timeEnd: '' }
    },

    enrichActivities(activities) {
      return activities.map((item) => {
        let walkingDistance = item.walkingDistance || item.distance || ''
        if (typeof walkingDistance === 'number') {
          walkingDistance = walkingDistance >= 1000
            ? (walkingDistance / 1000) + 'km'
            : walkingDistance + 'm'
        }
        const timeParts = this.parseTimeRange(item.time)
        return {
          ...item,
          timeStart: timeParts.timeStart,
          timeEnd: timeParts.timeEnd,
          showMap: item.type === '景点' && !!(item.lat && item.lng),
          walkingDistance
        }
      })
    },

    enrichMeals(meals) {
      return meals.map((item) => {
        const count = Math.min(5, Math.floor(item.rating || 0))
        return {
          ...item,
          starArray: Array.from({ length: count }, (_, i) => i + 1)
        }
      })
    },

    onTrackTap(e) {
      const { track } = e.currentTarget.dataset
      // TODO: 接入埋点 SDK
    },

    onToggleCollect() {
      const key = this.getPlanKey()
      let list = wx.getStorageSync(COLLECTED_PLANS_KEY) || []
      const collected = !this.data.collected

      if (collected) {
        if (list.indexOf(key) < 0) {
          list = list.concat(key)
        }
      } else {
        list = list.filter((item) => item !== key)
      }

      wx.setStorageSync(COLLECTED_PLANS_KEY, list)
      this.setData({ collected })
    },

    onOpenActivityMap(e) {
      const index = e.currentTarget.dataset.index
      const activity = (this.data.dayData.activities || [])[index]
      if (!activity) return

      const opts = { scale: 15 }
      if (activity.lat && activity.lng) {
        opts.latitude = activity.lat
        opts.longitude = activity.lng
        opts.name = activity.desc.slice(0, 30)
      } else if (this.data.dayData.location && this.data.dayData.location.latitude) {
        opts.latitude = this.data.dayData.location.latitude
        opts.longitude = this.data.dayData.location.longitude
        opts.name = this.data.dayData.location.name
      } else {
        opts.name = activity.desc.split(/[，,。]/)[0].slice(0, 30)
      }

      wx.openLocation({
        ...opts,
        fail() {
          wx.showToast({ title: '无法打开地图', icon: 'none' })
        }
      })
    }
  }
})

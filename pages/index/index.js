const { getNavLayout } = require('../../utils/safe-area')
const tripProfileUtil = require('../../utils/trip-profile')

function buildTagList(tags, selected) {
  const sel = selected || []
  return (tags || []).map(function (tag) {
    return { tag: tag, selected: sel.indexOf(tag) >= 0 }
  })
}

Page({
  data: {
    destination: '',
    days: '',
    companionOptions: tripProfileUtil.COMPANION_OPTIONS,
    companionType: '',
    childAgesText: '',
    elderlyCount: '',
    groupSize: '',
    travelMonth: '',
    travelStartDate: '',
    travelEndDate: '',
    paceOptions: tripProfileUtil.PACE_OPTIONS,
    pace: '',
    interestList: tripProfileUtil.buildInterestList([]),
    rankedInterestCodes: [],
    dietaryTags: tripProfileUtil.DIETARY_TAGS,
    dietaryTagList: [],
    selectedDietary: [],
    constraintsNoLimit: false,
    transportModes: tripProfileUtil.TRANSPORT_MODES,
    transportMode: '',
    extraNotes: '',
    showTripDetails: false,
    statusBarHeight: 20,
    tabBarPadding: 120
  },

  onLoad() {
    const layout = getNavLayout()
    const draft = tripProfileUtil.loadFormDraft()
    const patch = {
      statusBarHeight: layout.statusBarHeight,
      tabBarPadding: 100 + layout.safeAreaBottom
    }
    if (draft) {
      Object.assign(patch, draft)
      patch.interestList = tripProfileUtil.buildInterestList(draft.rankedInterestCodes || [])
      patch.dietaryTagList = buildTagList(tripProfileUtil.DIETARY_TAGS, draft.selectedDietary || [])
      patch.travelMonth = tripProfileUtil.normalizeTravelMonthValue(draft.travelMonth || '')
      if (draft.days === 0 || draft.days === '0') patch.days = ''
    } else {
      patch.travelMonth = ''
      patch.dietaryTagList = buildTagList(tripProfileUtil.DIETARY_TAGS, [])
    }
    this.setData(patch)
  },

  persistDraft() {
    const keys = [
      'destination', 'days', 'companionType', 'childAgesText', 'elderlyCount', 'groupSize',
      'travelMonth', 'travelStartDate', 'travelEndDate', 'pace', 'rankedInterestCodes',
      'selectedDietary', 'constraintsNoLimit', 'transportMode', 'extraNotes', 'showTripDetails'
    ]
    const draft = {}
    keys.forEach((k) => { draft[k] = this.data[k] })
    tripProfileUtil.saveFormDraft(draft)
  },

  onDestinationInput(e) {
    this.setData({ destination: e.detail.value })
    this.persistDraft()
  },

  onDaysInput(e) {
    const raw = String(e.detail.value || '').replace(/[^0-9]/g, '')
    this.setData({ days: raw })
    this.persistDraft()
  },

  onDaysStep(e) {
    const delta = parseInt(e.currentTarget.dataset.delta, 10)
    const current = parseInt(this.data.days || '0', 10) || 0
    const next = Math.max(0, current + delta)
    this.setData({ days: next > 0 ? String(next) : '' })
    this.persistDraft()
  },

  onCompanionSelect(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ companionType: this.data.companionType === value ? '' : value })
    this.persistDraft()
  },

  onChildAgesInput(e) {
    this.setData({ childAgesText: e.detail.value })
    this.persistDraft()
  },

  onElderlyCountInput(e) {
    this.setData({ elderlyCount: e.detail.value.replace(/[^0-9]/g, '') })
    this.persistDraft()
  },

  onGroupSizeInput(e) {
    this.setData({ groupSize: e.detail.value.replace(/[^0-9]/g, '') })
    this.persistDraft()
  },

  onTravelMonthChange(e) {
    this.setData({ travelMonth: e.detail.value })
    this.persistDraft()
  },

  onTravelStartChange(e) {
    this.setData({ travelStartDate: e.detail.value })
    this.persistDraft()
  },

  onTravelEndChange(e) {
    this.setData({ travelEndDate: e.detail.value })
    this.persistDraft()
  },

  onPaceSelect(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ pace: this.data.pace === value ? '' : value })
    this.persistDraft()
  },

  onToggleInterest(e) {
    const code = e.currentTarget.dataset.code
    let ranked = (this.data.rankedInterestCodes || []).slice()
    const idx = ranked.indexOf(code)
    if (idx >= 0) ranked.splice(idx, 1)
    else ranked.push(code)
    this.setData({
      rankedInterestCodes: ranked,
      interestList: tripProfileUtil.buildInterestList(ranked)
    })
    this.persistDraft()
  },

  onToggleDietary(e) {
    const tag = e.currentTarget.dataset.tag
    const list = (this.data.selectedDietary || []).slice()
    const idx = list.indexOf(tag)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(tag)
    this.setData({
      selectedDietary: list,
      dietaryTagList: buildTagList(tripProfileUtil.DIETARY_TAGS, list),
      constraintsNoLimit: false
    })
    this.persistDraft()
  },

  onConstraintsNoLimit(e) {
    const checked = !!e.detail.value.length
    this.setData({
      constraintsNoLimit: checked,
      selectedDietary: checked ? [] : this.data.selectedDietary,
      dietaryTagList: buildTagList(tripProfileUtil.DIETARY_TAGS, checked ? [] : this.data.selectedDietary)
    })
    this.persistDraft()
  },

  onTransportModeSelect(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ transportMode: this.data.transportMode === value ? '' : value })
    this.persistDraft()
  },

  onToggleTripDetails() {
    this.setData({ showTripDetails: !this.data.showTripDetails })
    this.persistDraft()
  },

  onExtraNotesInput(e) {
    this.setData({ extraNotes: e.detail.value })
    this.persistDraft()
  },

  onStartPlan() {
    if (this._startingPlan) return
    const data = this.data
    const dest = (data.destination || '').trim()
    if (!dest) {
      wx.showToast({ title: '请输入目的地', icon: 'none' })
      return
    }
    const dayRaw = String(data.days || '').trim()
    const dayNum = dayRaw ? parseInt(dayRaw, 10) : 0
    const days = Number.isFinite(dayNum) && dayNum >= 1 ? dayNum : 0
    if (dayRaw && (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 90)) {
      wx.showToast({ title: '天数请填 1–90，或留空', icon: 'none' })
      return
    }

    const tripProfile = data.showTripDetails
      ? tripProfileUtil.buildTripProfile({
        rankedInterestCodes: data.rankedInterestCodes,
        extraNotes: data.extraNotes,
        companionType: data.companionType,
        childAgesText: data.childAgesText,
        elderlyCount: data.elderlyCount,
        groupSize: data.groupSize,
        travelMonth: data.travelMonth,
        travelStartDate: data.travelStartDate,
        travelEndDate: data.travelEndDate,
        pace: data.pace,
        dietaryTags: data.selectedDietary,
        constraintsNoLimit: data.constraintsNoLimit,
        transportMode: data.transportMode
      })
      : null

    const query = days > 0 ? `${dest}${days}天` : dest
    const payload = {
      destination: dest,
      days,
      query
    }
    if (tripProfile) {
      payload.preferences = { tripProfile }
    }

    this._startingPlan = true
    wx.navigateTo({
      url: '/pages/planning/planning?data=' + encodeURIComponent(JSON.stringify(payload)),
      complete: () => {
        this._startingPlan = false
      }
    })
  }
})

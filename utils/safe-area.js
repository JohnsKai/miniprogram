function getNavLayout() {
  try {
    const sys = wx.getSystemInfoSync()
    const menu = wx.getMenuButtonBoundingClientRect()
    const statusBarHeight = sys.statusBarHeight || 20
    const gap = menu.top - statusBarHeight
    const navContentHeight = gap * 2 + menu.height
    const navBarHeight = statusBarHeight + navContentHeight
    const navPaddingRight = sys.windowWidth - menu.left + 8
    const safeAreaBottom = sys.safeArea
      ? Math.max(0, sys.screenHeight - sys.safeArea.bottom)
      : 0
    return {
      statusBarHeight,
      navBarHeight,
      navContentHeight,
      navPaddingRight,
      safeAreaBottom
    }
  } catch (e) {
    return {
      statusBarHeight: 20,
      navBarHeight: 64,
      navContentHeight: 44,
      navPaddingRight: 96,
      safeAreaBottom: 0
    }
  }
}

module.exports = { getNavLayout }

// 点工具栏上的插件图标就打开侧边栏（Chrome 116+）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

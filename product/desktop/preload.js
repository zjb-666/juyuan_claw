const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApp", {
  isDesktop: true,
  platform: process.platform,
  restart() {
    return ipcRenderer.invoke("desktop:restart");
  },
  /** Type B: local embedded Boss browser (not full PC control). */
  boss: {
    openLogin(opts) {
      return ipcRenderer.invoke("boss:open-login", opts || {});
    },
    checkLogin() {
      return ipcRenderer.invoke("boss:check-login");
    },
    refreshPreview() {
      return ipcRenderer.invoke("boss:refresh-preview");
    },
    showWindow() {
      return ipcRenderer.invoke("boss:show-window");
    },
    requestResumes(opts) {
      return ipcRenderer.invoke("boss:request-resumes", opts || {});
    },
    downloadResumes(opts) {
      return ipcRenderer.invoke("boss:download-resumes", opts || {});
    },
    requestAndDownloadResumes(opts) {
      return ipcRenderer.invoke("boss:request-and-download-resumes", opts || {});
    },
    enrichProfiles(opts) {
      return ipcRenderer.invoke("boss:enrich-profiles", opts || {});
    },
    autoRechat(opts) {
      return ipcRenderer.invoke("boss:auto-rechat", opts || {});
    },
    interviewInvite(opts) {
      return ipcRenderer.invoke("boss:interview-invite", opts || {});
    },
    checkInboxReplies(opts) {
      return ipcRenderer.invoke("boss:check-inbox-replies", opts || {});
    },
    scrapeInbox(opts) {
      return ipcRenderer.invoke("boss:scrape-inbox", opts || {});
    },
  },
  /** One-time disclosure: client may read/operate the local Boss window only. */
  consent: {
    version: 1,
    title: "本机浏览器权限说明",
    body: [
      "招聘助手会在你电脑上打开独立的 Boss 直聘窗口。",
      "为完成自动请求简历、下载简历、复聊，客户端会读取并模拟操作该窗口（仅限 Boss 直聘）。",
      "登录态、Cookie、出口 IP 留在本机，不会搬到服务器。",
      "服务端只做编排与评优；用户之间数据与记忆相互隔离。",
    ].join("\n"),
  },
});

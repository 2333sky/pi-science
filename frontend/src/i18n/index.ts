import i18next from "i18next";
import { initReactI18next } from "react-i18next";

const resources: Record<string, { translation: Record<string, string> }> = {
  en: {
    translation: {
      // Common
      "common.close": "Close",
      "common.cancel": "Cancel",
      "common.ok": "OK",
      "common.loading": "Loading…",
      "common.error": "Error",
      // Inspector
      "inspector.title": "Inspector",
      "inspector.loading": "Loading preview…",
      "inspector.error": "Failed to load preview",
      "inspector.noPreview": "Preview not available",
      "inspector.fileTooLarge": "File too large to preview",
      "inspector.unknownFormat": "Unknown format",
      "inspector.rawData": "Raw data",
      "inspector.download": "Download",
      "inspector.openExternally": "Open externally",
      "inspector.copyPath": "Copy path",
      // Session
      "session.send": "Send",
      "session.stop": "Stop",
      "session.thinking": "Thinking…",
      // Provenance / Version history
      "provenance.loadingHistory": "Loading history…",
      "provenance.emptyPrefix": "No recorded versions for ",
      "provenance.emptySuffix": " yet",
      "provenance.envTitle": "Environment info",
      "provenance.lockfileTitle": "View package lockfile",
      "provenance.packageCount": "{{count}} packages",
      "provenance.packageCount_plural": "{{count}} packages",
      "provenance.reproduceRunTitle": "Reproduce this run",
      "provenance.reproduceVersionTitle": "Reproduce this version",
      "provenance.reproduce": "Reproduce",
      "provenance.openConversationTitle": "Open conversation",
      "provenance.openConversation": "Conversation",
      "provenance.pipFreezePrefix": "pip freeze — ",
      "provenance.loadingLockfile": "Loading lockfile…",
      "provenance.producedByRunPrefix": "Produced by run ",
      "provenance.openRunTitle": "Open run",
      "provenance.commandSeparator": ": ",
      "provenance.producedByRunSuffix": "",
      "provenance.contentNotCaptured": "Content not captured",
    },
  },
  "zh-Hans": {
    translation: {
      "common.close": "关闭",
      "common.cancel": "取消",
      "common.ok": "确定",
      "common.loading": "加载中…",
      "common.error": "错误",
      "inspector.title": "检查器",
      "inspector.loading": "正在加载预览…",
      "inspector.error": "加载预览失败",
      "inspector.noPreview": "预览不可用",
      "session.send": "发送",
      "session.stop": "停止",
      "session.thinking": "思考中…",
      // Provenance / Version history
      "provenance.loadingHistory": "加载历史记录…",
      "provenance.emptyPrefix": "暂无 ",
      "provenance.emptySuffix": " 的版本记录",
      "provenance.envTitle": "环境信息",
      "provenance.lockfileTitle": "查看包锁文件",
      "provenance.packageCount": "{{count}} 个包",
      "provenance.packageCount_plural": "{{count}} 个包",
      "provenance.reproduceRunTitle": "复现此运行",
      "provenance.reproduceVersionTitle": "复现此版本",
      "provenance.reproduce": "复现",
      "provenance.openConversationTitle": "打开对话",
      "provenance.openConversation": "对话",
      "provenance.pipFreezePrefix": "pip freeze — ",
      "provenance.loadingLockfile": "加载锁文件中…",
      "provenance.producedByRunPrefix": "由运行 ",
      "provenance.openRunTitle": "打开运行",
      "provenance.commandSeparator": "：",
      "provenance.producedByRunSuffix": "",
      "provenance.contentNotCaptured": "内容未捕获",
    },
  },
};

i18next.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export { i18next };
export const i18n = i18next;
export default i18next;

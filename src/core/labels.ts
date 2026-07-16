import type {
  ActivityCategory,
  FocusState,
  NudgeReason,
  PetIntentKind,
  PetPlacementMode,
  RuleMatchKind,
  StateReason,
} from "./types";

export const focusStateLabels: Record<FocusState, { title: string; symbol: string; short: string }> = {
  focus: { title: "专注", symbol: "checkmark.circle.fill", short: "稳" },
  distracted: { title: "走神", symbol: "eye.trianglebadge.exclamationmark", short: "散" },
  break: { title: "休息", symbol: "cup.and.saucer.fill", short: "歇" },
  away: { title: "暂离", symbol: "moon.zzz.fill", short: "离" },
};

export const categoryLabels: Record<ActivityCategory, { title: string; correctionTitle: string }> = {
  work: { title: "工作工具", correctionTitle: "通常用于工作" },
  entertainment: { title: "容易分心", correctionTitle: "容易让我分心" },
  ignore: { title: "不参与判断", correctionTitle: "不参与判断" },
  neutral: { title: "旧数据", correctionTitle: "旧数据" },
};

export const ruleMatchKindLabels: Record<RuleMatchKind, string> = {
  appName: "App 名称",
  bundleID: "Bundle ID",
  windowTitle: "窗口标题",
};

export const nudgeReasonLabels: Record<NudgeReason, string> = {
  distractedOverThreshold: "注意力提醒",
  distractedStrong: "需要收束一下",
  longFocusRest: "建议休息",
  veryLongFocusRest: "该休息了",
  focusSessionCompleted: "专注完成",
  breakEnding: "休息结束",
  welcomeBack: "回到电脑",
  frequentSwitching: "切换过多",
};

export const petIntentLabels: Record<PetIntentKind, string> = {
  quietCompanion: "安静陪伴",
  focusRestHint: "专注休息提示",
  distractedObserve: "走神观察",
  nudgeGentle: "温和提醒",
  nudgeStrong: "强提醒",
  breakCompanion: "休息陪伴",
  breakEnding: "休息结束",
  sleep: "暂离睡觉",
  welcomeBack: "欢迎回来",
  moveLeft: "向左移动",
  moveRight: "向右移动",
  moveUp: "向上移动",
  moveDown: "向下移动",
  dragged: "拖拽中",
  landing: "落地",
  mouseSummon: "鼠标召回",
  dashboardGuide: "面板引导",
};

export const petPlacementLabels: Record<PetPlacementMode, string> = {
  bottomRight: "右下角",
  bottomLeft: "左下角",
  topRight: "右上角",
  topLeft: "左上角",
  dock: "Dock 附近",
  custom: "自定义",
};

export const stateReasonLabels: Record<StateReason, string> = {
  systemSleep: "系统睡眠",
  screenLocked: "屏幕锁定",
  longInputIdleAway: "输入长时间空闲",
  inputIdleDistracted: "输入空闲",
  activeBreak: "休息中",
  activeFocusSession: "专注会话",
  workCategory: "工作分类",
  entertainmentStable: "娱乐内容持续",
  entertainmentGrace: "娱乐宽限",
  frequentSwitching: "频繁切换",
  ignoredActivity: "忽略活动",
  previousStateHeld: "保持上一状态",
  neutralDefault: "默认状态",
  recentInputRecovery: "近期输入恢复",
};

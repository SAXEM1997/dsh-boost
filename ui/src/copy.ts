/**
 * Every string the page shows.
 *
 * One place, not because a translation layer needs it yet (T5 adds one), but
 * because a claim about measurement — "this is an estimate", "this is a lower
 * bound" — must be worded once. Two copies drift, and the drifted one is the
 * one a user reads before deciding to turn substitution on.
 */
export const TITLE = 'Token 效率'

export const INTRO =
  '投影裁剪工具回执、确定性替换可推导的调用。下面的数字全部来自收据，不是估算的替代品：' +
  '区间给出下界与上界，两者都不是精确值。'

export const SECTION_STATUS = '运行状态'
export const SECTION_SCOPE = '作用域'
export const SECTION_WORKSPACES = '工作区'
export const SECTION_CONFIG = '生效配置'

export const LABEL_DEGRADED = '降级项'
export const NO_DEGRADED = '没有降级项：宿主提供了这个插件需要的全部服务。'

export const LABEL_SAVED_UPPER = '替换节省（上界）'
export const LABEL_SAVED_LOWER = '替换节省（下界）'
export const LABEL_PROJECTION_NET = '投影净额'
export const LABEL_PROJECTION_GROSS = '投影毛额（一次性）'
export const LABEL_PROJECTION_GROSS_REPLAY = '投影毛额（按各自 horizon 重放）'
export const LABEL_RETRIEVALS = '取回次数'
export const LABEL_OVERHEAD = '常驻开销'
export const LABEL_ESTIMATE = '口径'

export const HINT_SAVED_UPPER =
  '上界是「下一次请求的输入」：它把被替换调用的结果也算进了节省，所以真实节省低于这个数。'
export const HINT_SAVED_LOWER =
  '下界是被跳过那次请求自己的总用量：它不含「后续还会回放多少次」，所以真实节省高于这个数。'
export const HINT_PROJECTION_NET =
  '净额 = 重放毛额 − 取回内容成本 − 取回调用成本。回放用每条回执自己的 horizon，不是当前值；' +
  '所以上面两个毛额不是同一个数，净额只与重放那个对齐。'
export const HINT_PROJECTION_GROSS_REPLAY =
  '每条回执的节省乘以它自己的 (1 + horizon) 再求和。这个数才是净额的被减数。'
export const HINT_OVERHEAD =
  '每次请求的常驻成本：协议段 + 工具 schema。它不随会话变化，也不被任何节省抵消。'

export const UNKNOWN = '未测量'
export const NOT_APPLICABLE = '—'

export const LABEL_MODE = '模式'
export const LABEL_WORKSPACE_IDS = '已选工作区'
export const LABEL_SHADOW = '影子模式'
export const LABEL_PROJECTION = '投影'
export const LABEL_REVISION = '修订号'

export const MODE_SELECTED = '仅选中的工作区'
export const MODE_GLOBAL = '全部工作区'
export const ON = '开'
export const OFF = '关'
export const PROJECTION_OFF = '不投影'
export const PROJECTION_SHADOW = '影子（只记账）'
export const PROJECTION_ON = '投影并替换回执'

export const NO_WORKSPACES_SELECTED = '还没有选中任何工作区：插件对任何会话都不生效。'
export const NO_WORKSPACES_IN_REGISTRY = '宿主的注册表里没有工作区。这不是「没选中」，是宿主那边确实一个都没有。'
export const CONFIG_UNAVAILABLE = '读不到生效配置：路由返回的 config 不是对象。页面不会把它显示成一张空表。'
export const SECTION_COUNTS = '收据计数'
export const NO_RECEIPTS = '还没有任何收据：插件在这个宿主上还没有产生过一次决策。'
export const WORKSPACES_UNAVAILABLE =
  '读不到工作区列表，所以保存被禁用。这不是「没有工作区」——是宿主没有提供注册表，或它读的时候抛错了。'

export const LABEL_CONFIG_KEY = '键'
export const LABEL_CONFIG_VALUE = '生效值'
export const CONFIG_READONLY =
  '这一栏是只读的。它显示的是启动时 resolveConfig 算出来的值（含 clamp 与回落），' +
  '改它要编辑 profile 的 cordis.patch.yml 并重启宿主。'

export const LOADING = '读取中…'
export const RETRY = '重试'

/** What to do about a degradation code, keyed by the code itself. */
export const DEGRADED_ADVICE: Record<string, string> = {
  ERR_HOST_NO_SPILL: '没有 spill 后端：投影不会发生。装上 dsh-spill 或等价的 spill 服务。',
  ERR_HOST_NO_SPILL_NOTICE: 'spill 后端在，但页脚产不出来：投影被跳过。检查 spill 通知模块是否被裁剪掉。',
  ERR_HOST_SPILL_FAILING: 'spill 后端在，但每次写都失败：投影被跳过。查后端日志，不是重装。',
  ERR_HOST_SPILL_UNUSABLE: 'spill 后端存在但不可用（没有 saveText）：投影被跳过。',
  ERR_HOST_NO_TOKENMETER: '没有 token 计量服务：替换被拒绝，投影仍可用但数字标为未测量。',
  ERR_HOST_NO_WORKSPACE_REGISTRY: '宿主没有工作区注册表：任何会话都解析不到工作区，插件全程惰性。',
  ERR_HOST_WORKSPACE_REGISTRY_BROKEN: '工作区注册表在，但 list() 抛错：工作区列表读不到。',
  ERR_HOST_SELECTOR_UNAVAILABLE: '选择器调不到模型：多候选只能回落到大模型决策。',
  ERR_HOST_COMPLETE_SECTION: '提示段被宿主吞掉了：协议段可能没有到达模型。',
  ERR_HOST_VERSION_MISMATCH: '宿主版本与 engines.dsh 的区间不符：本包没有在这个版本上验证过。',
  ERR_BOOST_PARTIAL_MOUNT: '有钩子没挂上：插件是部分装配的。看宿主日志里的缺失项。',
  ERR_BOOST_SECTION_REGISTER_FAILED: '提示段注册失败：协议段没有注入。',
}

export const DEGRADED_FALLBACK = '未收录的码：查 docs/RELEASE.md 的稳定码表。'

/**
 * One lookup with one fallback.
 *
 * The page asks this for both its own failures and the host's degradation
 * codes, so the two must not drift into two fallbacks.
 */
export function adviceFor(code: string): string {
  return DEGRADED_ADVICE[code] ?? ADVICE_FOR_CODE[code] ?? DEGRADED_FALLBACK
}

export const ADVICE_FOR_CODE: Record<string, string> = {
  ERR_HTTP_METHOD: '这个地址只接受读：写通道在保存那条路上，不在这里。',
  ERR_HTTP_NOT_FOUND: '插件没有这个子路径：页面与服务端的版本可能不一致。',
  ERR_HTTP_INTERNAL: '服务端读状态时抛了：通常是宿主服务在自己内部出错。看宿主日志。',
  ERR_HTTP_FORBIDDEN: '请求被同源栅栏拒绝：Host 不在受信列表里，或 Origin 与 Host 不一致。',
  ERR_HTTP_WORKSPACES_UNAVAILABLE: WORKSPACES_UNAVAILABLE,
  ERR_CLIENT_NETWORK: '读不到插件的数据路由：它可能没有挂上（看宿主日志里有没有 webServer）。',
  ERR_CLIENT_SHAPE: '数据路由返回了本页读不懂的形状：版本不匹配。',
}

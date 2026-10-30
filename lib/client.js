window.__ModuleLoader__.load({
  id: '@fg-lab/amadeus-life',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
const FIELDS = [
  {
    "key": "wakeDeliveryEnabled",
    "type": "boolean",
    "default": false,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "启用自主唤醒",
      "help": "允许 Host 对 allowlist 中的 Session 投递到期/空闲唤醒；默认关闭。"
    },
    "en": {
      "label": "Enable autonomous wake",
      "help": "Allow Host due/idle delivery for allowlisted Sessions. Off by default."
    }
  },
  {
    "key": "allowedSessionIds",
    "type": "array",
    "itemType": "string",
    "default": [],
    "restart": true,
    "group": "common",
    "zh": {
      "label": "授权 Session allowlist",
      "help": "只有这里列出的合法 DSH Session 可接收自主唤醒；不会自动枚举或伪造 Session。"
    },
    "en": {
      "label": "Allowed Session ids",
      "help": "Only these valid DSH Session ids may receive autonomous wake. Sessions are never enumerated or invented."
    }
  },
  {
    "key": "externalMessageSessionIds",
    "type": "array",
    "itemType": "string",
    "default": [],
    "restart": true,
    "group": "common",
    "zh": {
      "label": "外发提示 Session",
      "help": "必须是 Session allowlist 的子集；默认空列表保持非发送提示。仅这些 Session 内具有持久化模型工具来源的 intent wake 会收到可考虑使用外部工具的提示；idle 与其他意图仍保持非发送提示。本设置不会授予 QQ Scene 权限，实际 QQ 外发由 QQ Scene Guard 决定。"
    },
    "en": {
      "label": "External-message Session opt-in",
      "help": "Must be a subset of the Session allowlist; an empty list keeps non-sending guidance. Only intent wakes with persisted model-tool provenance in these Sessions receive guidance to consider external tools; idle and other intents keep non-sending guidance. This grants no QQ Scene permission; QQ Scene Guard decides whether a send is allowed."
    }
  },
  {
    "key": "wakeIntervalSeconds",
    "type": "number",
    "default": 60,
    "min": 15,
    "max": 600,
    "step": 15,
    "unit": "s",
    "restart": true,
    "group": "common",
    "zh": {
      "label": "唤醒检查间隔",
      "help": "低频检查节拍，15–600 秒；不是模型调用频率。"
    },
    "en": {
      "label": "Wake check interval",
      "help": "Low-frequency check cadence, 15–600 seconds; not a model-call rate."
    }
  },
  {
    "key": "maxPerDrive",
    "type": "number",
    "default": 1,
    "min": 1,
    "max": 5,
    "step": 1,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "单次最多投递",
      "help": "每次驱动最多投递的 wake 数，保持有界。"
    },
    "en": {
      "label": "Max wakes per drive",
      "help": "Bound the number of wakes delivered per drive."
    }
  },
  {
    "key": "idleEnabled",
    "type": "boolean",
    "default": false,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "启用空闲机会",
      "help": "在安静窗口后给目标 Session 一个可休息/静默的 idle 机会；不会自动发消息。"
    },
    "en": {
      "label": "Enable idle opportunities",
      "help": "Offer the target Session a rest/silent idle opportunity after quiet time; never sends messages."
    }
  },
  {
    "key": "idleTargetSessionId",
    "type": "string",
    "default": "",
    "restart": true,
    "group": "common",
    "zh": {
      "label": "Idle 目标 Session",
      "help": "必须同时出现在 allowlist 中。"
    },
    "en": {
      "label": "Idle target Session",
      "help": "Must also appear in the allowlist."
    }
  },
  {
    "key": "idleWindowMinutes",
    "type": "number",
    "default": 30,
    "min": 1,
    "max": 1440,
    "step": 1,
    "unit": "min",
    "restart": true,
    "group": "common",
    "zh": {
      "label": "Idle 窗口",
      "help": "同一 Session 两次 idle 机会之间的最小间隔。"
    },
    "en": {
      "label": "Idle window",
      "help": "Minimum interval between idle opportunities for one Session."
    }
  },
  {
    "key": "quietAfterActivityMinutes",
    "type": "number",
    "default": 5,
    "min": 0,
    "max": 1440,
    "step": 1,
    "unit": "min",
    "restart": true,
    "group": "common",
    "zh": {
      "label": "活动后安静期",
      "help": "最近 Session 事件后至少安静这么久才考虑 idle。"
    },
    "en": {
      "label": "Quiet after activity",
      "help": "Require this much quiet time after the latest Session event before idle."
    }
  },
  {
    "key": "quietStartHour",
    "type": "number",
    "default": -1,
    "min": -1,
    "max": 23,
    "step": 1,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "安静时段开始（UTC）",
      "help": "-1 关闭；0–23 为 UTC 小时。"
    },
    "en": {
      "label": "Quiet hours start (UTC)",
      "help": "-1 disables; 0–23 is the UTC hour."
    }
  },
  {
    "key": "quietEndHour",
    "type": "number",
    "default": -1,
    "min": -1,
    "max": 23,
    "step": 1,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "安静时段结束（UTC）",
      "help": "-1 关闭；支持跨午夜。"
    },
    "en": {
      "label": "Quiet hours end (UTC)",
      "help": "-1 disables; cross-midnight ranges are supported."
    }
  },
  {
    "key": "wakeBudgetEnabled",
    "type": "boolean",
    "default": false,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "启用自主预算",
      "help": "限制自主 wake、token 与活动并发；普通聊天不受影响。"
    },
    "en": {
      "label": "Enable autonomous budget",
      "help": "Limit autonomous wakes, tokens, and concurrent activities; normal chat is unaffected."
    }
  },
  {
    "key": "wakeLimit",
    "type": "number",
    "default": 20,
    "min": 0,
    "max": 10000,
    "step": 1,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "每周期唤醒上限",
      "help": "0 表示本周期不允许自主 wake。"
    },
    "en": {
      "label": "Wake limit per window",
      "help": "0 means no autonomous wake in the window."
    }
  },
  {
    "key": "wakeWindowHours",
    "type": "number",
    "default": 24,
    "min": 1,
    "max": 720,
    "step": 1,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "预算窗口（小时）",
      "help": "窗口滚动时保留未结算 token 预留。"
    },
    "en": {
      "label": "Budget window (hours)",
      "help": "Unsettled token reservations survive window rollover."
    }
  },
  {
    "key": "tokenLimit",
    "type": "number",
    "default": 0,
    "min": 0,
    "max": 10000000,
    "step": 100,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "Token 上限",
      "help": "0 表示未设置 token 上限；实际 usage 仍幂等结算。"
    },
    "en": {
      "label": "Token limit",
      "help": "0 means no token cap; official usage still settles idempotently."
    }
  },
  {
    "key": "costLimit",
    "type": "number",
    "default": 0,
    "min": 0,
    "max": 1000000,
    "step": 1,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "付费 cost 上限",
      "help": "0 表示未启用付费预留；不代表真实支付。"
    },
    "en": {
      "label": "Paid cost limit",
      "help": "0 disables paid reservations; this is not a payment integration."
    }
  },
  {
    "key": "activityLimit",
    "type": "number",
    "default": 0,
    "min": 0,
    "max": 100,
    "step": 1,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "活动并发上限",
      "help": "0 表示不启用；occupying 状态计入，终态释放。"
    },
    "en": {
      "label": "Activity concurrency limit",
      "help": "0 disables; occupying states count, terminal states release."
    }
  },
  {
    "key": "activityToolsEnabled",
    "type": "boolean",
    "default": false,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "开放本地活动工具",
      "help": "启用本地虚拟 Provider 的模型工具；需要有效 Session binding。"
    },
    "en": {
      "label": "Enable local activity tools",
      "help": "Expose local virtual Provider tools; requires an active Session binding."
    }
  },
  {
    "key": "sharedReadEnabled",
    "type": "boolean",
    "default": false,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "开放共享只读视图",
      "help": "只按 binding 与显式 grant 返回共享场景摘要。"
    },
    "en": {
      "label": "Enable shared read",
      "help": "Return shared Scene summaries only through the binding and explicit grants."
    }
  },
  {
    "key": "bootstrapEnabled",
    "type": "boolean",
    "default": false,
    "restart": true,
    "group": "common",
    "zh": {
      "label": "首次运行 bootstrap",
      "help": "创建一个稳定 Persona、每个 allowlist Session 一个 private Scene/binding；已有不同 binding 时 fail closed。"
    },
    "en": {
      "label": "First-run bootstrap",
      "help": "Create one stable Persona and one private Scene/binding per allowlisted Session; fail closed on a different existing binding."
    }
  },
  {
    "key": "bootstrapPersonaName",
    "type": "string",
    "default": "Amadeus",
    "max": 100,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "默认 Persona 名称",
      "help": "仅用于本地 bootstrap。"
    },
    "en": {
      "label": "Default Persona name",
      "help": "Used only by local bootstrap."
    }
  },
  {
    "key": "tickIntervalMs",
    "type": "number",
    "default": 1000,
    "min": 0,
    "max": 600000,
    "step": 100,
    "unit": "ms",
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "tick 间隔",
      "help": "0 关闭自动 tick，仅手动 tick。"
    },
    "en": {
      "label": "Tick interval",
      "help": "0 disables automatic tick; manual tick remains available."
    }
  },
  {
    "key": "maxReviewBatch",
    "type": "number",
    "default": 20,
    "min": 1,
    "max": 500,
    "step": 1,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "单次复查批量",
      "help": "每次 tick 最多处理的到期意图数。"
    },
    "en": {
      "label": "Review batch",
      "help": "Maximum due intents processed per tick."
    }
  },
  {
    "key": "databasePath",
    "type": "string",
    "default": "",
    "max": 4000,
    "restart": true,
    "group": "advanced",
    "zh": {
      "label": "SQLite 路径",
      "help": "留空使用 DSH_HOME/amadeus-life/life.sqlite；修改需重启。"
    },
    "en": {
      "label": "SQLite path",
      "help": "Empty uses DSH_HOME/amadeus-life/life.sqlite; restart required."
    }
  }
];
const DETAIL_FIELDS = FIELDS.filter((field) => [
  'wakeDeliveryEnabled',
  'allowedSessionIds',
  'externalMessageSessionIds',
  'idleEnabled',
  'activityToolsEnabled',
  'bootstrapEnabled',
].includes(field.key));
/**
 * Pure browser-side form logic, shared by the built lazy-CJS bundle and tests.
 *
 * No React and no Host import lives here, so the staged-draft, dirty, cancel,
 * conflict, reset, and preview transitions can be tested without a browser.
 */

/**
 * @param {Record<string, any>|undefined} snapshot - config form snapshot.
 * @returns {Record<string, any>} accepted effective values.
 */
function acceptedValues(snapshot) {
  return snapshot && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
}

/**
 * @param {Record<string, any>|undefined} snapshot - config form snapshot.
 * @returns {Record<string, any>} initial draft.
 */
function draftFromSnapshot(snapshot) {
  return {
    values: { ...acceptedValues(snapshot) },
    revision: snapshot?.revision,
    writable: snapshot?.writable === true,
    status: snapshot?.status ?? 'loading',
  };
}

/**
 * @param {Record<string, any>} draft - staged draft.
 * @param {number|undefined} revision - accepted revision.
 * @returns {Record<string, any>} next draft.
 */
function rebaseDraft(draft, revision) {
  return { ...draft, revision };
}

/**
 * @param {Record<string, any>} values - current values.
 * @param {Record<string, any>} accepted - accepted values.
 * @param {Array<Record<string, any>>} fields - field metadata.
 * @returns {string[]} dirty field keys.
 */
function dirtyFields(values, accepted, fields) {
  const dirty = [];
  for (const field of fields) {
    if (values[field.key] !== accepted[field.key]) dirty.push(field.key);
  }
  return dirty;
}

/**
 * @param {Record<string, any>} draft - draft.
 * @param {Record<string, any>} snapshot - accepted form snapshot.
 * @param {Array<Record<string, any>>} fields - metadata.
 * @returns {boolean} whether the draft differs from accepted values.
 */
function isDirty(draft, snapshot, fields) {
  return dirtyFields(draft.values, acceptedValues(snapshot), fields).length > 0;
}

/**
 * Whether a newer accepted revision conflicts with a dirty local draft.
 * @param {Record<string, any>|null} previousDraft - draft before the update.
 * @param {Record<string, any>} nextSnapshot - newly accepted snapshot.
 * @param {Array<Record<string, any>>} fields - metadata.
 * @param {boolean} initialized - whether a ready form has been observed.
 * @returns {boolean} true when the draft must not silently overwrite new data.
 */
function hasRevisionConflict(previousDraft, nextSnapshot, fields, initialized) {
  return Boolean(
    initialized &&
      previousDraft &&
      previousDraft.status === 'ready' &&
      nextSnapshot?.status === 'ready' &&
      nextSnapshot.revision !== previousDraft.revision &&
      isDirty(previousDraft, nextSnapshot, fields),
  );
}

/**
 * Build the ordered set operations for a save.
 * @param {Record<string, any>} draft - draft.
 * @param {Record<string, any>} snapshot - accepted snapshot.
 * @param {Array<Record<string, any>>} fields - metadata.
 * @returns {Array<{op: 'set', path: string[], value: unknown}>} operations.
 */
function buildSetOps(draft, snapshot, fields) {
  const accepted = acceptedValues(snapshot);
  return dirtyFields(draft.values, accepted, fields).map((key) => ({
    op: 'set',
    path: [key],
    value: draft.values[key],
  }));
}

/**
 * Build unset operations for restoring inherited defaults.
 * @param {Array<Record<string, any>>} fields - metadata.
 * @returns {Array<{op: 'unset', path: string[]}>} operations.
 */
function buildUnsetAllOps(fields) {
  return fields.map((field) => ({ op: 'unset', path: [field.key] }));
}

/**
 * Set one draft value without mutating the previous object.
 * @param {Record<string, any>} draft - draft.
 * @param {string} key - field.
 * @param {unknown} value - value.
 * @returns {Record<string, any>} next draft.
 */
function setDraftValue(draft, key, value) {
  return { ...draft, values: { ...draft.values, [key]: value } };
}

/**
 * Validate one draft field with its actual Config type and metadata.
 * Missing values fall back to the schema default so an untouched default form
 * is saveable; explicit invalid values still surface a field error.
 * @param {Record<string, any>} field - metadata.
 * @param {unknown} value - value.
 * @returns {string|null} error key or null.
 */
function validateField(field, value) {
  const actual = value === undefined ? field.default : value;
  if (field.type === 'boolean') return typeof actual === 'boolean' ? null : 'invalidBoolean';
  if (field.type === 'enum') {
    return Array.isArray(field.enum) && field.enum.includes(actual) ? null : 'invalidChoice';
  }
  if (field.type === 'array') {
    if (!Array.isArray(actual)) return 'invalidArray';
    const maxItems = field.max ?? 100;
    if (actual.length > maxItems) return 'tooManyItems';
    for (const entry of actual) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) return 'invalidArrayItem';
      if (
        (field.key === 'allowedSessionIds' || field.key === 'externalMessageSessionIds') &&
        !/^session-[A-Za-z0-9-]+$/.test(entry)
      ) return 'invalidSessionId';
    }
    return null;
  }
  if (field.type === 'string') {
    if (typeof actual !== 'string') return 'invalidString';
    if (field.max !== undefined && actual.length > field.max) return 'tooLong';
    if (field.key === 'idleTargetSessionId' && actual !== '' && !/^session-[A-Za-z0-9-]+$/.test(actual)) {
      return 'invalidSessionId';
    }
    return null;
  }
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return 'invalidNumber';
  if (field.min !== undefined && actual < field.min) return 'belowMin';
  if (field.max !== undefined && actual > field.max) return 'aboveMax';
  return null;
}

/**
 * Validate every draft field and cross-field identity constraints.
 * @param {Record<string, any>} values - values.
 * @param {Array<Record<string, any>>} fields - metadata.
 * @returns {Record<string, string>} key -> error key.
 */
function validateAll(values, fields) {
  const input = values && typeof values === 'object' ? values : {};
  const errors = {};
  for (const field of fields) {
    const error = validateField(field, input[field.key]);
    if (error) errors[field.key] = error;
  }
  const allowed = Array.isArray(input.allowedSessionIds) ? input.allowedSessionIds : [];
  const external = Array.isArray(input.externalMessageSessionIds) ? input.externalMessageSessionIds : [];
  if (
    errors.externalMessageSessionIds === undefined &&
    external.some((entry) => !allowed.includes(entry))
  ) {
    errors.externalMessageSessionIds = 'externalMessageNotAllowed';
  }
  const target = input.idleTargetSessionId;
  if (input.idleEnabled === true && !allowed.includes(target) && errors.idleTargetSessionId === undefined) {
    errors.idleTargetSessionId = 'idleTargetNotAllowed';
  }
  if (input.bootstrapEnabled === true && allowed.length === 0 && errors.bootstrapEnabled === undefined) {
    errors.bootstrapEnabled = 'bootstrapNeedsSessions';
  }
  const start = Number(input.quietStartHour);
  const end = Number(input.quietEndHour);
  const startSet = Number.isFinite(start) && start >= 0;
  const endSet = Number.isFinite(end) && end >= 0;
  if (startSet !== endSet) {
    if (errors.quietStartHour === undefined) errors.quietStartHour = 'quietHoursPair';
    if (errors.quietEndHour === undefined) errors.quietEndHour = 'quietHoursPair';
  }
  return errors;
}

/**
 * Coerce and clamp a number input from a range control.
 * @param {Record<string, any>} field - metadata.
 * @param {unknown} input - input.
 * @returns {number} clamped number.
 */
function clampFieldValue(field, input) {
  const value = Number(input);
  if (!Number.isFinite(value)) return Number(field.default);
  const min = field.min ?? Number.NEGATIVE_INFINITY;
  const max = field.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, value));
}

/**
 * Full plain config for a read-only preview request.
 * @param {Record<string, any>} values - draft values.
 * @param {Array<Record<string, any>>} fields - metadata.
 * @returns {Record<string, unknown>} config.
 */
function draftConfig(values, fields) {
  const output = {};
  for (const field of fields) output[field.key] = values[field.key];
  return output;
}

/**
 * @param {number} total - total rows.
 * @param {number} pageSize - page size.
 * @returns {number} page count, at least 1.
 */
function pageCount(total, pageSize) {
  return Math.max(1, Math.ceil(Number(total) / Math.max(1, Number(pageSize))));
}

/**
 * @param {number} page - requested page.
 * @param {number} total - rows.
 * @param {number} pageSize - size.
 * @returns {number} clamped page.
 */
function clampPage(page, total, pageSize) {
  return Math.min(pageCount(total, pageSize), Math.max(1, Math.floor(Number(page) || 1)));
}

/**
 * @param {number} value - number.
 * @returns {string} signed one-decimal display.
 */
function signed(value) {
  const n = Math.round(Number(value) * 10) / 10;
  return n > 0 ? `+${n}` : String(n);
}

/**
 * @param {Record<string, unknown>} deltas - state deltas.
 * @returns {string} compact delta text.
 */
function deltaText(deltas, lang = 'zh') {
  if (!deltas || typeof deltas !== 'object') return '—';
  const labels = lang === 'en'
    ? { mood: 'Mood', energy: 'Energy', curiosity: 'Curiosity', none: 'No material change' }
    : { mood: '心情', energy: '精力', curiosity: '好奇', none: '无明显变化' };
  return ['mood', 'energy', 'curiosity']
    .filter((key) => Number(deltas[key]) !== 0)
    .map((key) => `${labels[key]} ${signed(deltas[key])}`)
    .join(' / ') || labels.none;
}

/**
 * Human source label.
 * @param {string} source - source.
 * @param {'zh'|'en'} lang - language.
 * @returns {string} label.
 */
function sourceLabel(source, lang) {
  const zh = {
    model_appraisal: '模型评价',
    life: 'Life 活动',
    memory: 'Memory 引用',
    admin: '管理员',
    host: '宿主',
    manual: '人工',
  };
  const en = {
    model_appraisal: 'Model appraisal',
    life: 'Life activity',
    memory: 'Memory reference',
    admin: 'Administrator',
    host: 'Host',
    manual: 'Manual',
  };
  return (lang === 'en' ? en : zh)[source] ?? String(source);
}

/**
 * Human trust label.
 * @param {string} trust - trust.
 * @param {'zh'|'en'} lang - language.
 * @returns {string} label.
 */
function trustLabel(trust, lang) {
  const zh = { trusted: '可信来源', bounded: '受限低信任', admin: '管理员确认', untrusted: '不可信' };
  const en = { trusted: 'Trusted source', bounded: 'Bounded, low trust', admin: 'Admin confirmed', untrusted: 'Untrusted' };
  return (lang === 'en' ? en : zh)[trust] ?? String(trust);
}

/**
 * A stable preview explanation from a Host preview response.
 * @param {Record<string, any>} preview - preview response.
 * @param {'zh'|'en'} lang - language.
 * @returns {string} text.
 */
function previewText(preview, lang) {
  if (!preview) return '';
  const before = preview.before ?? {};
  const after = preview.after ?? {};
  if (lang === 'en') {
    return `Predicted after one event: Mood ${signed(before.mood)} → ${signed(after.mood)}, Energy ${before.energy} → ${after.energy}, Curiosity ${before.curiosity} → ${after.curiosity}. This preview does not write the database.`;
  }
  return `单个事件后的预计变化：心情 ${signed(before.mood)} → ${signed(after.mood)}，精力 ${before.energy} → ${after.energy}，好奇 ${before.curiosity} → ${after.curiosity}。预览不会写入数据库。`;
}


const NS = 'amadeus-life';
const API = '/api/amadeus-life';
const TABS = ['overview', 'setup', 'sessions', 'intents', 'activities', 'budget', 'workspace', 'advanced'];

const CSS = `
[data-amadeus-life]{
  --aml-accent:#4f6fe8;
  --aml-accent-strong:#3557cf;
  --aml-accent-soft:#eef3ff;
  --aml-surface:var(--dsw-alias-bg-layer-1,#ffffff);
  --aml-surface-2:var(--dsw-alias-bg-layer-2,#f6f8fc);
  --aml-line:var(--dsw-alias-border-secondary,#dfe5ef);
  --aml-text:var(--dsw-alias-label-primary,#1f2937);
  --aml-muted:var(--dsw-alias-label-secondary,#7b8798);
  box-sizing:border-box;max-width:100%;min-width:0;color:var(--aml-text);font-size:13px;line-height:1.6;padding:0 0 28px
}
[data-amadeus-life] *{box-sizing:border-box}
[data-amadeus-life] h2{margin:0;font-size:24px;line-height:1.25;letter-spacing:-.3px}
[data-amadeus-life] h3{margin:0 0 10px;font-size:15px;line-height:1.35;font-weight:730;letter-spacing:-.1px}
[data-amadeus-life] p{margin:7px 0}
[data-amadeus-life] small{display:block;color:var(--aml-muted);font-size:11.5px;line-height:1.55}
[data-amadeus-life] .topbar{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px;padding:20px;border:1px solid var(--aml-line);border-radius:18px;background:linear-gradient(135deg,var(--aml-surface) 0%,var(--aml-surface-2) 100%);box-shadow:0 8px 28px #1b2b4b0d}
[data-amadeus-life] .topbar h2{color:var(--aml-text)}
[data-amadeus-life] .topbar p{margin:5px 0 0;color:var(--aml-muted);max-width:620px}
[data-amadeus-life] .tabs,[data-amadeus-life] .actions,[data-amadeus-life] .chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
[data-amadeus-life] .tabs{padding:7px 0;margin:2px 0 16px;border-bottom:1px solid var(--aml-line);overflow-x:auto;scrollbar-width:thin}
[data-amadeus-life] .tabs button{border-color:transparent;background:transparent;color:var(--aml-muted);border-radius:10px;padding:7px 11px;white-space:nowrap;font-weight:650}
[data-amadeus-life] .tabs button:hover{background:var(--aml-surface-2);color:var(--aml-text)}
[data-amadeus-life] .tabs button[aria-selected=true]{background:var(--aml-accent);border-color:var(--aml-accent);color:#fff;box-shadow:0 4px 12px #4f6fe83d}
[data-amadeus-life] button{font:inherit;border:1px solid var(--aml-line);border-radius:9px;padding:7px 12px;background:var(--aml-surface);color:var(--aml-text);cursor:pointer;max-width:100%;min-height:34px;transition:background .15s,border-color .15s,box-shadow .15s}
[data-amadeus-life] button:hover:not(:disabled){background:var(--aml-surface-2);border-color:#b9c8e8}
[data-amadeus-life] button.primary{background:var(--aml-accent);border-color:var(--aml-accent);color:#fff;box-shadow:0 4px 12px #4f6fe836}
[data-amadeus-life] button.primary:hover:not(:disabled){background:var(--aml-accent-strong);border-color:var(--aml-accent-strong)}
[data-amadeus-life] button.danger{border-color:#e7b6b9;color:#b53c44;background: var(--aml-surface)}
[data-amadeus-life] button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
[data-amadeus-life] button:focus-visible,[data-amadeus-life] input:focus-visible,[data-amadeus-life] select:focus-visible,[data-amadeus-life] textarea:focus-visible,[data-amadeus-life] summary:focus-visible{outline:3px solid var(--aml-accent);outline-offset:2px}
[data-amadeus-life] .chip{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border:1px solid var(--aml-line);border-radius:999px;background:var(--aml-surface-2);font-size:11.5px;font-weight:620;overflow-wrap:anywhere}
[data-amadeus-life] .chip.ok{background:#eaf8ef;border-color:#c6e9d2;color:#2c7a4b}
[data-amadeus-life] .chip.warn{background:#fff7e7;border-color:#f0dfb8;color:#966b18}
[data-amadeus-life] .chip.bad{background:#fdeeee;border-color:#f0c7ca;color:#a83b43}
[data-amadeus-life] .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:11px;margin:10px 0 16px}
[data-amadeus-life] .card,[data-amadeus-life] .panel{border:1px solid var(--aml-line);border-radius:16px;padding:17px;background:var(--aml-surface);min-width:0;box-shadow:0 6px 20px #1b2b4b0a}
[data-amadeus-life] .card{display:flex;flex-direction:column;gap:5px;justify-content:space-between;min-height:88px;transition:transform .15s,box-shadow .15s}
[data-amadeus-life] .card:hover{transform:translateY(-1px);box-shadow:0 9px 26px #1b2b4b12}
[data-amadeus-life] .card .value{font-size:25px;font-weight:760;letter-spacing:-.4px;color:var(--aml-text)}
[data-amadeus-life] .panel{margin-bottom:14px}
[data-amadeus-life] .panel > p{color:var(--aml-muted)}
[data-amadeus-life] .field{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(180px,.85fr);gap:16px;padding:13px 0;border-bottom:1px solid var(--aml-line);align-items:start}
[data-amadeus-life] .field:last-child{border-bottom:0}
[data-amadeus-life] .field strong{font-size:12.5px;font-weight:700;color:var(--aml-text)}
[data-amadeus-life] .control{display:flex;flex-direction:column;gap:5px;min-width:0}
[data-amadeus-life] input[type=number],[data-amadeus-life] input[type=text],[data-amadeus-life] textarea,[data-amadeus-life] select{font:inherit;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--aml-line);border-radius:9px;background:var(--aml-surface-2);color:var(--aml-text);transition:border-color .15s,background .15s}
[data-amadeus-life] input:hover,[data-amadeus-life] select:hover,[data-amadeus-life] textarea:hover{border-color:#b9c8e8}
[data-amadeus-life] textarea{resize:vertical;min-height:64px}
[data-amadeus-life] .switch{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;border:1px solid var(--aml-line);border-radius:10px;background:var(--aml-surface-2)}
[data-amadeus-life] .switch input{width:18px;height:18px;margin-top:2px;accent-color:var(--aml-accent);flex:none}
[data-amadeus-life] .message{padding:10px 12px;border-radius:10px;border:1px solid var(--aml-line);background:var(--aml-surface-2);margin:10px 0;overflow-wrap:anywhere}
[data-amadeus-life] .message.error{background:#fdeeee;border-color:#f0c7ca;color:#94323a}
[data-amadeus-life] .message.success{background:#eaf8ef;border-color:#c6e9d2;color:#286f45}
[data-amadeus-life] .tableWrap{overflow:auto;max-width:100%;border:1px solid var(--aml-line);border-radius:13px;background:var(--aml-surface);box-shadow:0 3px 12px #1b2b4b08}
[data-amadeus-life] table{border-collapse:collapse;width:100%;min-width:660px;font-size:12px}
[data-amadeus-life] th,[data-amadeus-life] td{padding:10px 11px;text-align:left;vertical-align:top;border-bottom:1px solid var(--aml-line);overflow-wrap:anywhere}
[data-amadeus-life] th{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--aml-muted);background:var(--aml-surface-2);font-weight:750;position:sticky;top:0;z-index:1}
[data-amadeus-life] tbody tr:hover{background:var(--aml-surface-2)}
[data-amadeus-life] tbody tr:last-child td{border-bottom:0}
[data-amadeus-life] .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
[data-amadeus-life] .muted{color:var(--aml-muted)}
[data-amadeus-life] .errorText{color:#b53c44;font-size:11.5px;font-weight:600}
[data-amadeus-life] details summary{cursor:pointer;font-weight:650;color:var(--aml-text);padding:4px 0}
@media(max-width:760px){[data-amadeus-life] .topbar{padding:15px;border-radius:14px}[data-amadeus-life] .field{grid-template-columns:1fr;gap:6px}[data-amadeus-life] .grid{grid-template-columns:repeat(2,minmax(0,1fr))}[data-amadeus-life] table{min-width:560px}}
@media(max-width:480px){[data-amadeus-life] .grid{grid-template-columns:1fr}[data-amadeus-life] .topbar .actions{width:100%}[data-amadeus-life] .topbar .actions button{flex:1}}
`;

const STYLE_ELEMENT_ID = 'amadeus-life-plugin-styles';
const STYLE_PLUGIN_KEY = 'amadeus-life';

/**
 * Inject the plugin stylesheet once into document.head. DSH's React tree may
 * ignore a nested <style> element, so the stylesheet must live in the document
 * exactly like other DSH plugins. No-op during SSR/tests without a document.
 */
function ensureStyles(targetDocument) {
  const doc = targetDocument ?? (typeof globalThis !== 'undefined' ? globalThis.document : undefined);
  if (doc === undefined || doc === null || !doc.head) return;
  let element = doc.getElementById(STYLE_ELEMENT_ID);
  if (!element) {
    element = doc.createElement('style');
    element.id = STYLE_ELEMENT_ID;
    element.setAttribute('data-plugin-css', STYLE_PLUGIN_KEY);
    element.setAttribute('data-amadeus-life-style', 'true');
    try {
      const nonce = doc.head.querySelector?.('style[nonce]')?.getAttribute?.('nonce');
      if (nonce) element.setAttribute('nonce', nonce);
    } catch {
      // CSP nonce discovery is best-effort; a blocked style simply fails closed.
    }
    doc.head.appendChild(element);
  }
  if (element.textContent !== CSS) element.textContent = CSS;
}

ensureStyles();

const DICT = {
  zh: {
    nav: 'Amadeus Life', title: 'Amadeus Life', subtitle: '管理意图、活动、自主唤醒、预算和诊断。默认关闭自主行为；这里不会发送外部消息。',
    refresh: '刷新', save: '保存设置', saving: '保存中…', cancel: '取消修改', defaults: '恢复默认参数',
    saved: '设置已保存。Life 的调度与工具需要重启插件后按新配置运行；页面不会把重启前的变化显示为已生效。', saveFailed: '保存失败，草稿已保留。', conflict: '设置已在别处修改，请先载入最新值。',
    loading: '正在读取…', settingsUnavailable: '配置表单当前不可用；插件可能未加载。', requestFailed: '请求失败：',
    overview: '总览', setup: '自主唤醒', sessions: '会话规则', intents: '意图管理', activities: '活动中心', budget: '预算与注意力', workspace: '身份与工作区', advanced: '数据与诊断',
    basicConfig: '基础配置',
    intentFormTitle: '创建意图', intentDescription: '意图描述', reviewTime: '复查时间', createIntent: '创建意图', intentCreated: '意图已创建。',
    activityFormTitle: '启动本地活动', activityDescription: '活动目的', linkedIntent: '关联意图（可选）', startActivity: '启动活动', activityStarted: '本地活动已启动。',
    attention: '注意力', yieldToUser: '让位给用户', yieldConfirm: '将该 Session 的运行/暂停活动让位给真实用户？不会取消或销毁历史。', yielded: '已让位活动数：',
    backupTitle: '备份与恢复', backupHelp: '生成一致的 SQLite 快照并保存在数据目录的 backups 下。恢复请使用命令行预检/恢复流程，恢复前会保留旧数据库。',
    createBackup: '立即备份', backupCreated: '备份已创建：', backups: '备份列表', noBackups: '还没有备份。', backupRestoreHint: '恢复必须停止插件后使用 docs/UPGRADE.md 的 backup/restore 命令；GUI 不直接替换数据库。',
    requiredFields: '请填写所有必填字段。', invalidDate: '复查时间无效。', wakePolicy: '唤醒策略',
    workspaceTitle: '工作区', workspaceHelp: '绑定官方 DSH Workspace；显示名称只用于展示，授权来自工作区 Session 归属。绑定不会自动扩大自主唤醒。',
    bindWorkspace: '绑定工作区', activateWorkspace: '明确启用工作区自主唤醒', workspaceBound: '已绑定工作区', sessionRules: '会话规则',
    workspaceUnavailable: 'Workspace Registry 不可用；请确认 DSH 工作区服务已加载。', workspaceActivated: '工作区自主唤醒已明确启用。',
    bindConfirm: '绑定该 Workspace 的全部当前 Session？不会自动授予自主唤醒。', activateConfirm: '明确启用工作区全部继承/独立 Session 的自主唤醒？旧 allowlist 的语义不会自动扩大；仍然没有 QQ 外发权限。',
    mode: '模式', modeInherit: '继承工作区', modePassive: '仅被动参与', modeIndependent: '独立计划', modeDisabled: '完全停用',
    saveRule: '保存规则', independentLimits: '独立上限（不得超过全局预算）', wakeLimit: 'Wake 上限', tokenLimit: 'Token 上限', activityLimit: '活动并发上限',
    quietStart: '安静开始（0–23）', quietEnd: '安静结束（0–23）', wakeEligible: '可自主唤醒', wakeNotEligible: '不自主唤醒',
    ruleSaved: '会话规则已保存。', ruleYieldDegraded: '规则已保存，但活动保守暂停失败；请查看活动状态，未完成的活动不会被伪造为完成。', workspaceOutside: '工作区外', workspaceHint: '新加入工作区的 Session 自动继承默认规则；停用/被动模式不会自主唤醒。',
    defaultValue: '默认', range: '范围', unitLabel: '单位', empty: '空', working: '处理中…',
    normal: '正常运行', degraded: '降级', disabled: '已关闭', unavailable: '不可用', enabled: '已启用', configured: '已配置', unconfigured: '未配置',
    mode: '运行模式', authorizedSessions: '授权 Session', intentsCount: '意图', activitiesCount: '活动', recentWake: '最近唤醒', lastError: '最近错误', setupState: '首次配置',
    refreshHint: '数据按需读取，不使用高频刷新。', noData: '暂无数据。', loadingData: '正在读取数据…',
    setupIntro: '选择一个安全预设，然后保存并在需要时重启。预设只会修改配置；首次 bootstrap 会创建默认身份。',
    core: '仅核心管理', autonomous: '自主唤醒', activity: '本地活动',
    coreHelp: '不启用 Host 唤醒、idle、自主预算或新活动工具。', autonomousHelp: '只对 allowlist Session 启用低频到期/idle 唤醒，默认预算和 bootstrap。', activityHelp: '启用本地虚拟活动工具和 bootstrap；Host 唤醒仍关闭。',
    sessionIds: 'Session allowlist（每行或逗号分隔）', applyPreset: '应用预设到草稿', bootstrapNow: '立即创建默认身份',
    allowlistTitle: '允许接收自主唤醒的 Session', allowlistHelp: '不会枚举或伪造 Session；请从 DSH Session 列表复制合法 ID。授权与私有范围由现有 binding 决定。',
    externalMessageTitle: '外发提示（仅限工具来源的 intent wake）',
    bindings: 'Persona / Scene 绑定', privacy: '范围', private: '私有', shared: '共享', active: '有效', revoked: '已撤销',
    noBindings: '还没有绑定。使用首次配置的 bootstrap，或由管理员手动绑定。', revoke: '撤销授权', revokeConfirm: '撤销该 Session 的授权？待处理 wakes 和它拥有的活动会保守变为 unknown；不会删除历史。',
    editIntent: '编辑', saveIntent: '保存修改', intentUpdated: '意图已更新。', cancelIntent: '取消意图', cancelIntentConfirm: '取消这个意图？会按 revision CAS 执行，不会删除历史。',
    pause: '暂停', resume: '恢复', cancelActivity: '取消活动', cancelActivityConfirm: '请求取消该活动？只有 Provider 信任边界的证据才能最终确认。',
    noIntents: '暂无意图。', noActivities: '暂无活动。', noWakes: '暂无唤醒记录。',
    budgetTitle: '统一自主预算', budgetHelp: 'token 为预留/实际归账；cost 只是受信任预留账本，不触发付款。usage_unknown 时保留保守预留。',
    scope: '范围', used: '已用', reserved: '预留', remaining: '剩余', notConfigured: '未配置', token: 'Token', wake: '唤醒', cost: 'Cost', activityConcurrency: '活动并发',
    advancedHelp: '这些参数影响 tick、批处理、数据库和安静时段。高风险字段需确认；修改通常需要重启。',
    restart: '需要重启', live: '立即可读', unchanged: '没有修改。', invalid: '数值超出合法范围。', loadingForm: '正在读取配置…',
    invalidFields: '请修正标红的字段后再保存。', invalidBoolean: '必须是开/关值。', invalidNumber: '必须是有限数字。',
    invalidString: '必须是文本。', tooLong: '文本过长。', invalidArray: '必须是列表。', tooManyItems: '列表项过多。',
    invalidArrayItem: '列表项必须是非空文本。', invalidSessionId: '必须是合法的 DSH Session id。', invalidChoice: '不是允许的选项。',
    externalMessageNotAllowed: '外发提示 Session 必须同时位于 Session allowlist 中。',
    belowMin: '小于允许的最小值。', aboveMax: '大于允许的最大值。', idleTargetNotAllowed: 'Idle 目标必须位于 Session allowlist。',
    allowlistRequired: '启用自主唤醒前必须填写至少一个 Session。', bootstrapNeedsSessions: '启用 bootstrap 前必须填写至少一个 Session。',
    quietHoursPair: '安静时段开始和结束必须同时填写，或同时设为 -1。',
    unsaved: '有未保存的修改。', readOnly: '当前配置只读。', reload: '载入最新值', confirmDefaults: '恢复默认参数？不会删除意图、活动、预算或历史。', done: '完成。',
    setupFailed: '首次配置失败：', setupReady: '首次配置已完成。', noPermission: '只有已认证的 DSH 所有者可以管理 Life。', disconnected: 'Host 未连接或设置 API 不可用。',
    bundle: '数据库与版本', schema: 'Schema', database: '数据库', health: '健康', recentWakes: '最近唤醒', count: '数量', total: '总数',
    page: '页', prev: '上一页', next: '下一页', details: '详情', status: '状态', revision: 'Revision', time: '时间', action: '操作',
    bootstrapConflict: '已有不同的 Persona/Scene 绑定；不会覆盖，请保留原绑定或使用新 Session。',
  },
  en: {
    nav: 'Amadeus Life', title: 'Amadeus Life', subtitle: 'Manage intents, activities, autonomous wake, budgets, and diagnostics. Autonomous behavior is off by default; nothing is sent externally.',
    refresh: 'Refresh', save: 'Save settings', saving: 'Saving…', cancel: 'Discard changes', defaults: 'Restore defaults',
    saved: 'Settings saved. Life scheduling and tools apply after the plugin restarts; the page does not claim they are live before then.', saveFailed: 'Save failed; your draft was preserved.', conflict: 'Settings changed elsewhere. Load the latest values first.',
    loading: 'Loading…', settingsUnavailable: 'The config form is unavailable; the plugin may not be active.', requestFailed: 'Request failed: ',
    overview: 'Overview', setup: 'Autonomous wake', sessions: 'Session rules', intents: 'Intent management', activities: 'Activity center', budget: 'Budget & attention', workspace: 'Identity & workspace', advanced: 'Data & diagnostics',
    basicConfig: 'Basic configuration',
    intentFormTitle: 'Create intent', intentDescription: 'Intent description', reviewTime: 'Review time', createIntent: 'Create intent', intentCreated: 'Intent created.',
    activityFormTitle: 'Start local activity', activityDescription: 'Activity purpose', linkedIntent: 'Linked intent (optional)', startActivity: 'Start activity', activityStarted: 'Local activity started.',
    attention: 'Attention', yieldToUser: 'Yield to user', yieldConfirm: 'Yield running/paused activities in this Session to the real user? Nothing is cancelled or destroyed.', yielded: 'Activities yielded: ',
    backupTitle: 'Backup and restore', backupHelp: 'Create a consistent SQLite snapshot under the data directory backups folder. Restore uses the CLI preflight/restore flow and preserves the old database.',
    createBackup: 'Back up now', backupCreated: 'Backup created: ', backups: 'Backups', noBackups: 'No backups yet.', backupRestoreHint: 'Restore requires stopping the plugin and using the backup/restore commands in docs/UPGRADE.md; the GUI never replaces SQLite directly.',
    requiredFields: 'Fill in all required fields.', invalidDate: 'The review time is invalid.', wakePolicy: 'Wake policy',
    workspaceTitle: 'Workspace', workspaceHelp: 'Bind an official DSH Workspace. Display names are informational; authorization comes from current Session membership. Binding does not widen autonomous wake.',
    bindWorkspace: 'Bind workspace', activateWorkspace: 'Explicitly enable workspace-wide wake', workspaceBound: 'Workspace bound', sessionRules: 'Session rules',
    workspaceUnavailable: 'Workspace Registry is unavailable; verify the DSH workspace service is loaded.', workspaceActivated: 'Workspace-wide autonomous wake is explicitly enabled.',
    bindConfirm: 'Bind all current Sessions of this Workspace? This does not grant autonomous wake.', activateConfirm: 'Explicitly enable autonomous wake for all inherited/independent Sessions in this Workspace? The old allowlist semantics will not silently expand; no QQ send permission is granted.',
    mode: 'Mode', modeInherit: 'Inherit workspace', modePassive: 'Passive only', modeIndependent: 'Independent plan', modeDisabled: 'Disabled',
    saveRule: 'Save rule', independentLimits: 'Independent limits (must stay under global budget)', wakeLimit: 'Wake limit', tokenLimit: 'Token limit', activityLimit: 'Activity limit',
    quietStart: 'Quiet start (0–23)', quietEnd: 'Quiet end (0–23)', wakeEligible: 'Autonomous wake eligible', wakeNotEligible: 'No autonomous wake',
    ruleSaved: 'Session rule saved.', ruleYieldDegraded: 'Rule saved, but conservative activity pause failed; inspect activity state. Nothing is marked completed.', workspaceOutside: 'Outside workspace', workspaceHint: 'New Sessions in the workspace inherit the default rule; passive/disabled modes never receive autonomous wake.',
    defaultValue: 'Default', range: 'Range', unitLabel: 'Unit', empty: 'empty', working: 'Working…',
    normal: 'Running', degraded: 'Degraded', disabled: 'Disabled', unavailable: 'Unavailable', enabled: 'Enabled', configured: 'Configured', unconfigured: 'Not configured',
    mode: 'Mode', authorizedSessions: 'Allowed Sessions', intentsCount: 'Intents', activitiesCount: 'Activities', recentWake: 'Latest wake', lastError: 'Latest error', setupState: 'First run',
    refreshHint: 'Data is loaded on demand, not with a high-frequency refresh.', noData: 'No data.', loadingData: 'Loading data…',
    setupIntro: 'Pick a safe preset, save it, and restart if needed. Presets only change config; first-run bootstrap creates the default identity.',
    core: 'Core only', autonomous: 'Autonomous wake', activity: 'Local activity',
    coreHelp: 'No Host wake, idle, autonomous budget, or new activity tools.', autonomousHelp: 'Low-frequency due/idle wake only for allowlisted Sessions, with default budget and bootstrap.', activityHelp: 'Local virtual activity tools and bootstrap; Host wake remains off.',
    sessionIds: 'Session allowlist (one per line or comma separated)', applyPreset: 'Apply preset to draft', bootstrapNow: 'Create default identity now',
    allowlistTitle: 'Sessions allowed to receive autonomous wake', allowlistHelp: 'Sessions are not enumerated or invented. Copy valid ids from the DSH Session list. Binding/privacy stays authoritative.',
    externalMessageTitle: 'External-tool guidance (model-tool intent wake only)',
    bindings: 'Persona / Scene bindings', privacy: 'Privacy', private: 'Private', shared: 'Shared', active: 'Active', revoked: 'Revoked',
    noBindings: 'No bindings yet. Use first-run bootstrap or ask an administrator to bind manually.', revoke: 'Revoke', revokeConfirm: 'Revoke this Session? Pending wakes and its activities become conservative unknown; history is kept.',
    editIntent: 'Edit', saveIntent: 'Save changes', intentUpdated: 'Intent updated.', cancelIntent: 'Cancel intent', cancelIntentConfirm: 'Cancel this intent using revision CAS? History is kept.',
    pause: 'Pause', resume: 'Resume', cancelActivity: 'Cancel activity', cancelActivityConfirm: 'Request cancellation? Only Provider evidence can confirm a terminal result.',
    noIntents: 'No intents.', noActivities: 'No activities.', noWakes: 'No wake records.',
    budgetTitle: 'Unified autonomous budget', budgetHelp: 'Tokens are reserved/settled; cost is a trusted reservation ledger and never triggers payment. Missing usage keeps a conservative reservation.',
    scope: 'Scope', used: 'Used', reserved: 'Reserved', remaining: 'Remaining', notConfigured: 'Not configured', token: 'Token', wake: 'Wake', cost: 'Cost', activityConcurrency: 'Activity concurrency',
    advancedHelp: 'These affect tick, batching, database, and quiet hours. Restart is typically required.',
    restart: 'Restart required', live: 'Read live', unchanged: 'No changes.', invalid: 'Value is out of range.', loadingForm: 'Loading config…',
    invalidFields: 'Fix the highlighted fields before saving.', invalidBoolean: 'Must be on or off.', invalidNumber: 'Must be a finite number.',
    invalidString: 'Must be text.', tooLong: 'Text is too long.', invalidArray: 'Must be a list.', tooManyItems: 'Too many list items.',
    invalidArrayItem: 'Each list item must be non-empty text.', invalidSessionId: 'Must be a valid DSH Session id.', invalidChoice: 'Not an allowed choice.',
    externalMessageNotAllowed: 'External-message Sessions must also be in the Session allowlist.',
    belowMin: 'Below the allowed minimum.', aboveMax: 'Above the allowed maximum.', idleTargetNotAllowed: 'The idle target must be in the Session allowlist.',
    allowlistRequired: 'Add at least one Session before enabling autonomous wake.', bootstrapNeedsSessions: 'Add at least one Session before enabling bootstrap.',
    quietHoursPair: 'Set both quiet-hour bounds, or set both to -1.',
    unsaved: 'Unsaved changes.', readOnly: 'Configuration is read-only.', reload: 'Load latest', confirmDefaults: 'Restore defaults? Intents, activities, budgets, and history are not deleted.', done: 'Done.',
    setupFailed: 'First-run setup failed: ', setupReady: 'First-run setup completed.', noPermission: 'Only the authenticated DSH owner can manage Life.', disconnected: 'Host unavailable or settings API disconnected.',
    bundle: 'Database & version', schema: 'Schema', database: 'Database', health: 'Health', recentWakes: 'Recent wakes', count: 'Count', total: 'Total',
    page: 'Page', prev: 'Prev', next: 'Next', details: 'Details', status: 'Status', revision: 'Revision', time: 'Time', action: 'Action',
    bootstrapConflict: 'A different Persona/Scene binding exists; nothing was overwritten. Keep it or use a new Session.',
  },
};

function locale() {
  const language = typeof navigator !== 'undefined' ? String(navigator.language ?? 'zh') : 'zh';
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json', 'x-amadeus-life': '1' } : {}),
      ...(options.headers || {}),
    },
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function fieldLabel(field, lang) {
  return (field[lang] && field[lang].label) || field[lang === 'zh' ? 'en' : 'zh'].label || field.key;
}
function fieldHelp(field, lang) {
  return (field[lang] && field[lang].help) || field[lang === 'zh' ? 'en' : 'zh'].help || '';
}
function defaultValue(field) {
  return Array.isArray(field.default) ? [...field.default] : field.default;
}
function ConfigFields({ fields, draft, change, disabled, lang, t, errors = {} }) {
  return h(
    'div',
    null,
    fields.map((field) => {
      const value = draft.values[field.key];
      const id = 'life-config-' + field.key;
      const control = field.type === 'boolean'
        ? h('label', { className: 'switch', htmlFor: id },
            h('input', { id, type: 'checkbox', checked: value === true, disabled, onChange: (e) => change(field.key, e.target.checked) }),
            h('span', null, value ? t('enabled') : t('disabled')))
        : field.type === 'array'
          ? h('textarea', {
              id,
              value: Array.isArray(value) ? value.join('\n') : '',
              disabled,
              onChange: (e) => change(field.key, e.target.value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean)),
            })
          : field.type === 'string'
            ? h('input', { id, type: 'text', value: value ?? '', disabled, onChange: (e) => change(field.key, e.target.value) })
            : h('input', {
                id, type: 'number', value: value ?? 0, min: field.min, max: field.max, step: field.step,
                disabled, onChange: (e) => change(field.key, Number(e.target.value)),
              });
      const defaultText = Array.isArray(field.default)
        ? (field.default.length === 0 ? t('empty') : field.default.join(', '))
        : String(field.default ?? '');
      const hints = [];
      if (field.default !== undefined) hints.push(`${t('defaultValue')}: ${defaultText === '' ? t('empty') : defaultText}`);
      if (field.min !== undefined || field.max !== undefined) hints.push(`${t('range')}: ${field.min ?? '—'}–${field.max ?? '—'}`);
      if (field.unit) hints.push(`${t('unitLabel')}: ${field.unit}`);
      return h('div', { className: 'field', key: field.key },
        h('div', null,
          h('label', { htmlFor: id }, h('strong', null, fieldLabel(field, lang))),
          h('small', null, fieldHelp(field, lang)),
          hints.length ? h('small', { className: 'muted' }, hints.join(' · ')) : null,
          field.restart ? h('small', { className: 'muted' }, t('restart')) : null),
        h('div', { className: 'control' }, control,
          errors[field.key] ? h('small', { className: 'errorText', role: 'alert' }, t(errors[field.key])) : null));
    }));
}

function Panel({ ctx }) {
  ensureStyles();
  const lang = locale();
  const t = React.useCallback((key) => (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key, [lang]);
  const [tab, setTab] = React.useState('overview');
  const [snapshot, setSnapshot] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [health, setHealth] = React.useState(null);
  const [bindings, setBindings] = React.useState([]);
  const [intents, setIntents] = React.useState({ total: 0, items: [] });
  const [activities, setActivities] = React.useState({ total: 0, items: [] });
  const [wakes, setWakes] = React.useState([]);
  const [backups, setBackups] = React.useState([]);
  const [workspaceData, setWorkspaceData] = React.useState(null);
  const [workspaceChoice, setWorkspaceChoice] = React.useState('');
  const [ruleDrafts, setRuleDrafts] = React.useState({});
  const [intentForm, setIntentForm] = React.useState({ targetSessionId: '', description: '', reviewAt: '' });
  const [activityForm, setActivityForm] = React.useState({ targetSessionId: '', description: '', intentId: '' });
  const [backupBusy, setBackupBusy] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const formRef = React.useRef(null);
  const draftRef = React.useRef(null);
  const conflictRef = React.useRef(false);
  const alive = React.useRef(true);
  draftRef.current = draft;

  const loadData = React.useCallback(async () => {
    if (!alive.current) return;
    try {
      const status = await api('/status');
      if (!alive.current) return;
      setHealth(status);
      setWakes(Array.isArray(status.recentWakes) ? status.recentWakes : []);
      const [b, i, a, backupsResult, workspaceResult] = await Promise.all([
        api('/bindings'), api('/intents'), api('/activities'), api('/backups'), api('/workspace'),
      ]);
      if (!alive.current) return;
      setBindings(b.bindings || []);
      setIntents(i);
      setActivities(a);
      setBackups(Array.isArray(backupsResult.backups) ? backupsResult.backups : []);
      setWorkspaceData(workspaceResult.workspace ?? null);
      setError('');
    } catch (e) {
      if (alive.current) setError(t('requestFailed') + e.message);
    }
  }, [t]);

  React.useEffect(() => {
    alive.current = true;
    let form;
    try {
      form = ctx.configForms.get(NS);
      formRef.current = form;
    } catch {
      setError(t('settingsUnavailable'));
    }
    if (!form) {
      loadData();
      return () => { alive.current = false; };
    }
    const sync = () => {
      if (!alive.current) return;
      const next = form.getSnapshot();
      if (hasRevisionConflict(draftRef.current, next, FIELDS, draftRef.current !== null)) {
        conflictRef.current = true;
        setError(t('conflict'));
      }
      setSnapshot(next);
      setDraft((previous) => {
        if (previous === null || previous.status !== 'ready') return draftFromSnapshot(next);
        if (!isDirty(previous, next, FIELDS)) return draftFromSnapshot(next);
        return { ...previous, revision: next.revision, writable: next.writable, status: next.status };
      });
    };
    sync();
    const unsubscribe = form.subscribe(sync);
    loadData();
    return () => {
      alive.current = false;
      unsubscribe();
      try { form.dispose(); } catch { /* ignore */ }
    };
  }, [ctx, loadData, t]);

  const change = (key, value) => {
    setDraft((previous) => setDraftValue(previous, key, value));
    setMessage('');
    setError('');
  };
  const current = () => formRef.current?.getSnapshot();
  const errors = draft ? validateAll(draft.values, FIELDS) : {};
  const hasErrors = Object.keys(errors).length > 0;
  const dirty = draft && snapshot ? isDirty(draft, snapshot, FIELDS) : false;
  const disabled = busy || !draft || draft.status !== 'ready' || draft.writable !== true;
  const commonFields = FIELDS.filter((field) => field.group !== 'advanced');
  const advancedFields = FIELDS.filter((field) => field.group === 'advanced');

  const save = async () => {
    const form = formRef.current;
    const accepted = current();
    if (!form || !accepted || !draft) return;
    if (conflictRef.current) return setError(t('conflict'));
    if (hasErrors) return setError(t('invalid'));
    if (dirtyFields(draft.values, acceptedValues(accepted), FIELDS).length === 0) return setMessage(t('unchanged'));
    setBusy(true); setError(''); setMessage('');
    try {
      const ops = buildSetOps(draft, accepted, FIELDS);
      const ok = await form.mutate(ops, accepted.revision);
      if (!ok) { conflictRef.current = true; return setError(t('conflict')); }
      if (draft.values.bootstrapEnabled && Array.isArray(draft.values.allowedSessionIds) && draft.values.allowedSessionIds.length > 0) {
        try {
          await api('/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
              sessionIds: draft.values.allowedSessionIds,
              personaName: draft.values.bootstrapPersonaName || 'Amadeus',
            }),
          });
        } catch (bootstrapError) {
          setError(t('setupFailed') + bootstrapError.message + ' — ' + t('bootstrapConflict'));
        }
      }
      setMessage(t('saved'));
      conflictRef.current = false;
      await loadData();
    } catch (e) {
      setError(t('saveFailed') + ' ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    const accepted = current();
    if (accepted) setDraft(draftFromSnapshot(accepted));
    conflictRef.current = false; setError(''); setMessage('');
  };

  const restoreDefaults = async () => {
    if (!window.confirm(t('confirmDefaults'))) return;
    const form = formRef.current;
    const accepted = current();
    if (!form || !accepted) return;
    setBusy(true); setError('');
    try {
      const ok = await form.mutate(buildUnsetAllOps(FIELDS), accepted.revision);
      if (!ok) setError(t('conflict'));
      else { setMessage(t('done')); await loadData(); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const preset = (name) => {
    if (!draft) return;
    const allowed = draft.values.allowedSessionIds || [];
    const next = name === 'autonomous'
      ? { wakeDeliveryEnabled: true, idleEnabled: true, idleTargetSessionId: allowed[0] || '', wakeBudgetEnabled: true, activityLimit: Math.max(1, Number(draft.values.activityLimit) || 1), bootstrapEnabled: true, activityToolsEnabled: draft.values.activityToolsEnabled, sharedReadEnabled: draft.values.sharedReadEnabled }
      : name === 'activity'
        ? { wakeDeliveryEnabled: false, idleEnabled: false, wakeBudgetEnabled: false, activityToolsEnabled: true, bootstrapEnabled: true }
        : { wakeDeliveryEnabled: false, idleEnabled: false, wakeBudgetEnabled: false, activityToolsEnabled: false, sharedReadEnabled: false, bootstrapEnabled: false };
    setDraft((previous) => {
      let result = previous;
      for (const [key, value] of Object.entries(next)) result = setDraftValue(result, key, value);
      return result;
    });
    setMessage(t('applyPreset'));
    setError('');
  };

  const bootstrapNow = async () => {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const result = await api('/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          sessionIds: draft.values.allowedSessionIds || [],
          personaName: draft.values.bootstrapPersonaName || 'Amadeus',
        }),
      });
      setMessage(t('setupReady') + ' ' + (result.setup.personaId || ''));
      await loadData();
    } catch (e) { setError(t('setupFailed') + e.message); }
    finally { setBusy(false); }
  };

  const revoke = async (targetSessionId) => {
    if (!window.confirm(t('revokeConfirm'))) return;
    try { await api('/bindings/revoke', { method: 'POST', body: JSON.stringify({ targetSessionId }) }); await loadData(); }
    catch (e) { setError(e.message); }
  };
  const cancelIntent = async (item) => {
    if (!window.confirm(t('cancelIntentConfirm'))) return;
    try { await api('/intents/cancel', { method: 'POST', body: JSON.stringify({ id: item.id, targetSessionId: item.targetSessionId, expectedRevision: item.revision }) }); await loadData(); }
    catch (e) { setError(e.message); }
  };
  const editIntent = async (item) => {
    const description = window.prompt(t('intentDescription'), item.description);
    if (description === null || !description.trim()) return;
    const reviewAt = window.prompt(t('reviewTime'), item.reviewAt);
    if (reviewAt === null || !reviewAt) return;
    try {
      await api('/intents/update', { method: 'POST', body: JSON.stringify({ id: item.id, targetSessionId: item.targetSessionId, expectedRevision: item.revision, description: description.trim(), reviewAt }) });
      setMessage(t('intentUpdated'));
      await loadData();
    } catch (e) { setError(e.message); }
  };
  const activityAction = async (action, item) => {
    if (action === 'cancel' && !window.confirm(t('cancelActivityConfirm'))) return;
    try { await api('/activities/action', { method: 'POST', body: JSON.stringify({ action, id: item.id }) }); await loadData(); }
    catch (e) { setError(e.message); }
  };
  const createIntent = async () => {
    if (!intentForm.targetSessionId || !intentForm.description.trim() || !intentForm.reviewAt) {
      setError(t('requiredFields'));
      return;
    }
    let reviewAt;
    try { reviewAt = new Date(intentForm.reviewAt).toISOString(); } catch { setError(t('invalidDate')); return; }
    setBusy(true); setError('');
    try {
      await api('/intents/create', {
        method: 'POST',
        body: JSON.stringify({
          targetSessionId: intentForm.targetSessionId,
          description: intentForm.description.trim(),
          reviewAt,
        }),
      });
      setIntentForm({ targetSessionId: intentForm.targetSessionId, description: '', reviewAt: '' });
      setMessage(t('intentCreated'));
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const startActivity = async () => {
    if (!activityForm.targetSessionId || !activityForm.description.trim()) {
      setError(t('requiredFields'));
      return;
    }
    setBusy(true); setError('');
    try {
      await api('/activities/start', {
        method: 'POST',
        body: JSON.stringify({
          targetSessionId: activityForm.targetSessionId,
          description: activityForm.description.trim(),
          ...(activityForm.intentId.trim() ? { intentId: activityForm.intentId.trim() } : {}),
        }),
      });
      setActivityForm({ targetSessionId: activityForm.targetSessionId, description: '', intentId: '' });
      setMessage(t('activityStarted'));
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const yieldAttention = async (targetSessionId) => {
    if (!window.confirm(t('yieldConfirm'))) return;
    setBusy(true); setError('');
    try {
      const result = await api('/attention/yield', { method: 'POST', body: JSON.stringify({ targetSessionId }) });
      setMessage(t('yielded') + ' ' + String(result.outcomes?.length ?? 0));
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const makeBackup = async () => {
    setBackupBusy(true); setError('');
    try {
      const result = await api('/backups', { method: 'POST', body: '{}' });
      setMessage(t('backupCreated') + ' ' + result.backup.fileName);
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBackupBusy(false); }
  };
  const bindWorkspace = async () => {
    if (!workspaceChoice) { setError(t('requiredFields')); return; }
    if (!window.confirm(t('bindConfirm'))) return;
    setBusy(true); setError('');
    try {
      await api('/workspace/bind', { method: 'POST', body: JSON.stringify({ workspaceId: workspaceChoice, personaName: draft.values.bootstrapPersonaName || 'Amadeus' }) });
      setMessage(t('workspaceBound'));
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const activateWorkspace = async () => {
    if (!window.confirm(t('activateConfirm'))) return;
    setBusy(true); setError('');
    try {
      await api('/workspace/activate', { method: 'POST', body: JSON.stringify({ acknowledgeLegacy: true }) });
      setMessage(t('workspaceActivated'));
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const ruleValue = (sessionId, key, fallback) => ruleDrafts[sessionId]?.[key] ?? fallback;
  const changeRule = (sessionId, key, value) => setRuleDrafts((previous) => ({
    ...previous,
    [sessionId]: { ...(previous[sessionId] || {}), [key]: value },
  }));
  const saveRule = async (session) => {
    const draftRule = ruleDrafts[session.sessionId] || {};
    const mode = draftRule.mode ?? session.mode;
    const limit = (value, fallback) => {
      const raw = value ?? fallback;
      if (raw === undefined || raw === null || raw === '') return null;
      const number = Number(raw);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    setBusy(true); setError('');
    try {
      const response = await api('/workspace/rule', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.sessionId,
          mode,
          wakeLimit: mode === 'independent' ? limit(draftRule.wakeLimit, session.rule?.wakeLimit) : null,
          tokenLimit: mode === 'independent' ? limit(draftRule.tokenLimit, session.rule?.tokenLimit) : null,
          activityLimit: mode === 'independent' ? limit(draftRule.activityLimit, session.rule?.activityLimit) : null,
          quietStartHour: mode === 'independent' ? limit(draftRule.quietStartHour, session.rule?.quietStartHour) : null,
          quietEndHour: mode === 'independent' ? limit(draftRule.quietEndHour, session.rule?.quietEndHour) : null,
        }),
      });
      if (response.rule?.activityYield?.status === 'degraded') setError(t('ruleYieldDegraded'));
      else setMessage(t('ruleSaved'));
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!draft || !snapshot || snapshot.status === 'loading') {
    return h('div', { 'data-amadeus-life': 'true' },
       h('h2', null, t('title')),
      h('p', { role: 'status' }, t('loadingForm')), error ? h('div', { className: 'message error', role: 'alert' }, error) : null);
  }
  if (snapshot.status === 'unavailable') {
    return h('div', { 'data-amadeus-life': 'true' },
       h('h2', null, t('title')),
      h('p', { role: 'alert' }, t('settingsUnavailable')));
  }

  const activeBindings = bindings.filter((binding) => binding.active);
  const sessionOptions = workspaceData?.binding
    ? (workspaceData.sessions || []).filter((session) => session.member && session.mode !== 'disabled')
        .map((session) => session.sessionId)
    : [...new Set([
        ...(Array.isArray(draft.values.allowedSessionIds) ? draft.values.allowedSessionIds : []),
        ...activeBindings.map((binding) => binding.targetSessionId),
      ])];
  const overlay = h('div', { 'data-amadeus-life': 'true' },
        h('div', { className: 'topbar' },
      h('div', null, h('h2', null, t('title')), h('p', { className: 'muted' }, t('subtitle'))),
      h('div', { className: 'actions' },
        h('button', { type: 'button', onClick: loadData, disabled: busy }, t('refresh')),
        h('button', { type: 'button', className: 'primary', onClick: save, disabled: disabled || hasErrors || !dirty }, busy ? t('saving') : t('save')),
        h('button', { type: 'button', onClick: cancel, disabled: busy || (!dirty && !conflictRef.current) }, t('cancel')),
        h('button', { type: 'button', onClick: restoreDefaults, disabled: disabled }, t('defaults')))),
    h('div', { className: 'chips' },
      h('span', { className: 'chip ' + (health?.health?.state === 'ok' ? 'ok' : 'warn') }, t('health') + ': ' + (health?.health?.state || t('unavailable'))),
      health?.setup?.state ? h('span', { className: 'chip ' + (health.setup.state === 'ready' ? 'ok' : 'warn') }, t('setupState') + ': ' + health.setup.state) : null,
      dirty ? h('span', { className: 'chip warn' }, t('unsaved')) : null),
    h('div', { className: 'tabs', role: 'tablist' }, TABS.map((name) => h('button', {
      key: name, type: 'button', role: 'tab', 'aria-selected': tab === name, onClick: () => setTab(name),
    }, t(name)))),
    error ? h('div', { className: 'message error', role: 'alert' }, error) : null,
    hasErrors ? h('div', { className: 'message error', role: 'alert' }, t('invalidFields')) : null,
    message ? h('div', { className: 'message success', role: 'status' }, message) : null,
    tab === 'overview' ? h('div', null,
      h('div', { className: 'grid' },
        h('div', { className: 'card' }, h('small', null, t('mode')), h('div', { className: 'value' }, health?.setup?.state === 'ready' ? t('autonomous') : t('configured'))),
        h('div', { className: 'card' }, h('small', null, t('authorizedSessions')), h('div', { className: 'value' }, bindings.filter((b) => b.active).length)),
        h('div', { className: 'card' }, h('small', null, t('intentsCount')), h('div', { className: 'value' }, intents.total ?? 0)),
        h('div', { className: 'card' }, h('small', null, t('activitiesCount')), h('div', { className: 'value' }, activities.total ?? 0))),
      h('div', { className: 'panel' }, h('h3', null, t('wakePolicy')),
        h('div', { className: 'chips' },
          h('span', { className: 'chip' }, t('autonomous') + ': ' + (draft.values.wakeDeliveryEnabled ? t('enabled') : t('disabled'))),
          h('span', { className: 'chip' }, t('sessionIds') + ': ' + (draft.values.allowedSessionIds || []).length),
          h('span', { className: 'chip' }, t('wake') + ': ' + (draft.values.wakeIntervalSeconds ?? '—') + 's'),
          h('span', { className: 'chip' }, t('budget') + ': ' + (draft.values.wakeBudgetEnabled ? t('enabled') : t('disabled'))),
          h('span', { className: 'chip' }, t('activityConcurrency') + ': ' + (draft.values.activityLimit ?? 0))),
        h('small', null, t('restart'))),
      h('div', { className: 'panel' }, h('h3', null, t('recentWakes')),
        wakes.length === 0 ? h('p', { className: 'muted' }, t('noWakes')) : h('div', { className: 'tableWrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, t('time')), h('th', null, t('status')), h('th', null, t('scope')), h('th', null, t('lastError')))),
          h('tbody', null, wakes.map((wake) => h('tr', { key: wake.id },
            h('td', null, wake.createdAt), h('td', null, wake.status), h('td', null, wake.targetSessionId), h('td', null, wake.lastError || '—'))))))),
      health?.health?.error ? h('div', { className: 'message error' }, t('lastError') + ': ' + health.health.error) : null)
      : null,
    tab === 'setup' ? h('div', null,
      h('div', { className: 'panel' }, h('h3', null, t('setup')), h('p', null, t('setupIntro')),
        h('div', { className: 'actions' },
          h('button', { type: 'button', onClick: () => preset('core') }, t('core')),
          h('button', { type: 'button', onClick: () => preset('autonomous') }, t('autonomous')),
          h('button', { type: 'button', onClick: () => preset('activity') }, t('activity'))),
        h('small', null, t('coreHelp')), h('small', null, t('autonomousHelp')), h('small', null, t('activityHelp')),
        h('label', { htmlFor: 'life-session-ids' }, h('strong', null, t('sessionIds'))),
        h('textarea', {
          id: 'life-session-ids', value: (draft.values.allowedSessionIds || []).join('\n'),
          onChange: (e) => change('allowedSessionIds', e.target.value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean)),
        }),
        h('div', { className: 'actions' },
          h('button', { type: 'button', onClick: bootstrapNow, disabled: busy }, t('bootstrapNow')))),
      h('div', { className: 'panel' }, h('h3', null, t('advanced')), h('p', null, t('advancedHelp')),
        h(ConfigFields, { fields: commonFields, draft, change, disabled, lang, t, errors })))
      : null,
    tab === 'sessions' ? h('div', null,
      h('div', { className: 'panel' },
        h('h3', null, t('allowlistTitle')),
        h('p', null, t('allowlistHelp')),
        h('textarea', {
          value: (draft.values.allowedSessionIds || []).join('\n'),
          onChange: (e) => change('allowedSessionIds', e.target.value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean)),
        })),
      h('div', { className: 'panel' },
        h('h3', null, t('externalMessageTitle')),
        h(ConfigFields, {
          fields: FIELDS.filter((field) => field.key === 'externalMessageSessionIds'),
          draft, change, disabled, lang, t, errors,
        })),
      h('div', { className: 'panel' },
        h('h3', null, t('bindings')),
        bindings.length === 0
          ? h('p', { className: 'muted' }, t('noBindings'))
          : h('div', { className: 'tableWrap' },
              h('table', null,
                h('thead', null,
                  h('tr', null,
                    h('th', null, 'Session'),
                    h('th', null, 'Persona'),
                    h('th', null, 'Scene'),
                    h('th', null, t('privacy')),
                    h('th', null, t('status')),
                    h('th', null, t('attention')),
                    h('th', null, t('action')))),
                h('tbody', null, bindings.map((binding) => (
                  h('tr', { key: binding.targetSessionId },
                    h('td', null, binding.targetSessionId),
                    h('td', null, binding.personaName || binding.personaId),
                    h('td', null, binding.sceneId),
                    h('td', null, binding.privacy === 'private' ? t('private') : t('shared')),
                    h('td', null, binding.active ? t('active') : t('revoked')),
                    h('td', null, binding.active ? h('button', {
                      type: 'button',
                      disabled: busy,
                      onClick: () => yieldAttention(binding.targetSessionId),
                    }, t('yieldToUser')) : '—'),
                    h('td', null,
                      h('button', {
                        type: 'button',
                        className: 'danger',
                        disabled: busy,
                        onClick: () => revoke(binding.targetSessionId),
                      }, t('revoke'))))
                ))))))
    ) : null,
    tab === 'intents' ? h('div', null,
      h('div', { className: 'panel' }, h('h3', null, t('intentFormTitle')),
        h('label', { htmlFor: 'life-intent-session' }, h('strong', null, 'Session')),
        h('select', {
          id: 'life-intent-session', value: intentForm.targetSessionId,
          onChange: (e) => setIntentForm((previous) => ({ ...previous, targetSessionId: e.target.value })),
        }, h('option', { value: '' }, '—'), sessionOptions.map((sessionId) => h('option', { key: sessionId, value: sessionId }, sessionId))),
        h('label', { htmlFor: 'life-intent-description' }, h('strong', null, t('intentDescription'))),
        h('textarea', {
          id: 'life-intent-description', value: intentForm.description,
          onChange: (e) => setIntentForm((previous) => ({ ...previous, description: e.target.value })),
        }),
        h('label', { htmlFor: 'life-intent-review' }, h('strong', null, t('reviewTime'))),
        h('input', {
          id: 'life-intent-review', type: 'datetime-local', value: intentForm.reviewAt,
          onChange: (e) => setIntentForm((previous) => ({ ...previous, reviewAt: e.target.value })),
        }),
        h('div', { className: 'actions' },
          h('button', { type: 'button', className: 'primary', onClick: createIntent, disabled: busy || sessionOptions.length === 0 }, t('createIntent')))),
      h('div', { className: 'panel' }, h('h3', null, t('intents')),
        intents.items?.length ? h('div', { className: 'tableWrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, t('status')), h('th', null, t('details')), h('th', null, t('time')), h('th', null, t('action')))),
          h('tbody', null, intents.items.map((item) => h('tr', { key: item.id },
            h('td', null, item.status), h('td', null, item.description), h('td', null, item.reviewAt),
            h('td', null, item.status === 'active' ? h('div', { className: 'row' },
              h('button', { type: 'button', onClick: () => editIntent(item), disabled: busy }, t('editIntent')),
              h('button', { type: 'button', className: 'danger', onClick: () => cancelIntent(item), disabled: busy }, t('cancelIntent'))) : '—')))))) : h('p', { className: 'muted' }, t('noIntents'))))
      : null,
    tab === 'activities' ? h('div', null,
      h('div', { className: 'panel' }, h('h3', null, t('activityFormTitle')),
        h('label', { htmlFor: 'life-activity-session' }, h('strong', null, 'Session')),
        h('select', {
          id: 'life-activity-session', value: activityForm.targetSessionId,
          onChange: (e) => setActivityForm((previous) => ({ ...previous, targetSessionId: e.target.value })),
        }, h('option', { value: '' }, '—'), sessionOptions.map((sessionId) => h('option', { key: sessionId, value: sessionId }, sessionId))),
        h('label', { htmlFor: 'life-activity-description' }, h('strong', null, t('activityDescription'))),
        h('textarea', {
          id: 'life-activity-description', value: activityForm.description,
          onChange: (e) => setActivityForm((previous) => ({ ...previous, description: e.target.value })),
        }),
        h('label', { htmlFor: 'life-activity-intent' }, h('strong', null, t('linkedIntent'))),
        h('input', {
          id: 'life-activity-intent', type: 'text', value: activityForm.intentId,
          onChange: (e) => setActivityForm((previous) => ({ ...previous, intentId: e.target.value })),
        }),
        h('div', { className: 'actions' },
          h('button', { type: 'button', className: 'primary', onClick: startActivity, disabled: busy || sessionOptions.length === 0 }, t('startActivity')))),
      h('div', { className: 'panel' }, h('h3', null, t('activities')),
        activities.items?.length ? h('div', { className: 'tableWrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, t('status')), h('th', null, t('details')), h('th', null, 'Provider'), h('th', null, t('scope')), h('th', null, t('action')))),
          h('tbody', null, activities.items.map((item) => h('tr', { key: item.id },
            h('td', null, item.status), h('td', null, item.description), h('td', null, item.providerId || '—'), h('td', null, item.ownerScope),
            h('td', null, h('div', { className: 'row' },
              item.status === 'running' ? h('button', { type: 'button', onClick: () => activityAction('pause', item), disabled: busy }, t('pause')) : null,
              item.status === 'paused' ? h('button', { type: 'button', onClick: () => activityAction('resume', item), disabled: busy }, t('resume')) : null,
              ['running', 'paused', 'stopping', 'unknown'].includes(item.status) ? h('button', { type: 'button', className: 'danger', onClick: () => activityAction('cancel', item), disabled: busy }, t('cancelActivity')) : null))))))) : h('p', { className: 'muted' }, t('noActivities'))))
      : null,
    tab === 'budget' ? h('div', { className: 'panel' },
      h('h3', null, t('budgetTitle')),
      h('p', null, t('budgetHelp')),
      (health?.budgets?.length
        ? h('div', { className: 'tableWrap' },
            h('table', null,
              h('thead', null,
                h('tr', null,
                  h('th', null, t('scope')),
                  h('th', null, t('wake')),
                  h('th', null, t('token')),
                  h('th', null, t('cost')),
                  h('th', null, t('activityConcurrency')))),
              h('tbody', null, health.budgets.map((budget) => {
                const tokenLimit = budget.tokenLimit === null ? t('unconfigured') : budget.tokenLimit;
                return h('tr', { key: budget.scope },
                  h('td', null, budget.scope),
                  h('td', null, `${budget.wakeCalls ?? 0}/${budget.wakeLimit ?? '—'}`),
                  h('td', null, `${budget.tokensUsed ?? 0} ${t('used')} / ${budget.tokensReserved ?? 0} ${t('reserved')} / ${tokenLimit}`),
                  h('td', null, `${budget.costUsed ?? 0} / ${budget.costReserved ?? 0} / ${budget.costLimit ?? '—'}`),
                  h('td', null, budget.activityLimit ?? t('disabled')));
              }))))
        : h('p', { className: 'muted' }, t('unconfigured'))))
      : null,
    tab === 'workspace' ? h('div', null,
      h('div', { className: 'panel' },
        h('h3', null, t('workspaceTitle')),
        h('p', { className: 'muted' }, t('workspaceHelp')),
        workspaceData === null ? h('p', { className: 'muted' }, t('loadingData')) : null,
        workspaceData && workspaceData.workspaces?.length === 0
          ? h('div', { className: 'message error' }, t('workspaceUnavailable'))
          : null,
        workspaceData && workspaceData.binding === null ? h('div', { className: 'actions' },
          h('select', {
            value: workspaceChoice,
            onChange: (e) => setWorkspaceChoice(e.target.value),
          }, h('option', { value: '' }, '—'), (workspaceData.workspaces || []).map((workspace) => h('option', {
            key: workspace.id, value: workspace.id,
          }, `${workspace.title || workspace.id} (${workspace.sessionIds?.length ?? 0})`))),
          h('button', { type: 'button', className: 'primary', onClick: bindWorkspace, disabled: busy }, t('bindWorkspace')))
          : null,
        workspaceData && workspaceData.binding ? h('div', null,
          h('div', { className: 'chips' },
            h('span', { className: 'chip' }, workspaceData.binding.title || workspaceData.binding.workspaceId),
            h('span', { className: 'chip' }, `${t('workspaceBound')}: ${workspaceData.binding.workspaceId}`),
            h('span', { className: 'chip' }, `Persona: ${workspaceData.binding.personaId}`),
            h('span', { className: 'chip ' + (workspaceData.binding.activated ? 'ok' : 'warn') },
              workspaceData.binding.activated ? t('workspaceActivated') : t('activateWorkspace'))),
          workspaceData.binding.activated ? null : h('div', { className: 'actions' },
            h('button', { type: 'button', className: 'primary', onClick: activateWorkspace, disabled: busy }, t('activateWorkspace'))),
          h('small', null, t('workspaceHint')))
          : null),
      h('div', { className: 'panel' },
        h('h3', null, t('sessionRules')),
        !workspaceData?.sessions?.length ? h('p', { className: 'muted' }, t('noData')) : h('div', { className: 'tableWrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Session'), h('th', null, t('mode')), h('th', null, t('independentLimits')), h('th', null, t('wakeEligible')), h('th', null, t('action')))),
          h('tbody', null, workspaceData.sessions.map((session) => {
            const currentMode = ruleValue(session.sessionId, 'mode', session.mode);
            return h('tr', { key: session.sessionId },
              h('td', null, session.sessionId),
              h('td', null, h('select', {
                value: currentMode,
                onChange: (e) => changeRule(session.sessionId, 'mode', e.target.value),
              },
              ['inherit', 'passive', 'independent', 'disabled'].map((mode) => h('option', { key: mode, value: mode }, t(`mode${mode[0].toUpperCase()}${mode.slice(1)}`))))),
              h('td', null, currentMode === 'independent' ? h('div', { className: 'row' },
                h('input', { type: 'number', min: 0, className: 'form-input', placeholder: t('wakeLimit'), value: ruleValue(session.sessionId, 'wakeLimit', session.rule?.wakeLimit ?? ''), onChange: (e) => changeRule(session.sessionId, 'wakeLimit', e.target.value) }),
                h('input', { type: 'number', min: 0, className: 'form-input', placeholder: t('tokenLimit'), value: ruleValue(session.sessionId, 'tokenLimit', session.rule?.tokenLimit ?? ''), onChange: (e) => changeRule(session.sessionId, 'tokenLimit', e.target.value) }),
                h('input', { type: 'number', min: 0, className: 'form-input', placeholder: t('activityLimit'), value: ruleValue(session.sessionId, 'activityLimit', session.rule?.activityLimit ?? ''), onChange: (e) => changeRule(session.sessionId, 'activityLimit', e.target.value) }),
                h('input', { type: 'number', min: 0, max: 23, className: 'form-input', placeholder: t('quietStart'), value: ruleValue(session.sessionId, 'quietStartHour', session.rule?.quietStartHour ?? ''), onChange: (e) => changeRule(session.sessionId, 'quietStartHour', e.target.value) }),
                h('input', { type: 'number', min: 0, max: 23, className: 'form-input', placeholder: t('quietEnd'), value: ruleValue(session.sessionId, 'quietEndHour', session.rule?.quietEndHour ?? ''), onChange: (e) => changeRule(session.sessionId, 'quietEndHour', e.target.value) })) : '—'),
              h('td', null, h('small', null, session.eligibleWake ? t('wakeEligible') : t('wakeNotEligible'))),
              h('td', null, h('button', { type: 'button', onClick: () => saveRule(session), disabled: busy }, t('saveRule'))));
          }))))
      ))
      : null,
    tab === 'advanced' ? h('div', null,
      h('div', { className: 'panel' },
        h('h3', null, t('advanced')),
        h('p', null, t('advancedHelp')),
        h(ConfigFields, { fields: advancedFields, draft, change, disabled, lang, t, errors })),
      h('div', { className: 'panel' },
        h('h3', null, t('bundle')),
        h('div', { className: 'grid' },
          h('div', { className: 'card' }, h('small', null, t('schema')), h('div', { className: 'value' }, health?.health?.schemaVersion || '—')),
          h('div', { className: 'card' }, h('small', null, t('health')), h('div', { className: 'value' }, health?.health?.state || '—')),
          h('div', { className: 'card' }, h('small', null, t('database')), h('div', { className: 'value' }, health?.config?.databasePath || 'default'))),
        health?.health?.lastTickError ? h('div', { className: 'message error' }, health.health.lastTickError) : null),
      h('div', { className: 'panel' },
        h('h3', null, t('backupTitle')),
        h('p', null, t('backupHelp')),
        h('div', { className: 'actions' },
          h('button', { type: 'button', className: 'primary', onClick: makeBackup, disabled: backupBusy },
            backupBusy ? t('working') : t('createBackup'))),
        h('h3', null, t('backups')),
        backups.length === 0
          ? h('p', { className: 'muted' }, t('noBackups'))
          : h('div', { className: 'tableWrap' },
              h('table', null,
                h('thead', null,
                  h('tr', null,
                    h('th', null, 'File'),
                    h('th', null, 'Size'),
                    h('th', null, 'SHA-256'))),
                h('tbody', null, backups.map((backup) => h('tr', { key: backup.fileName },
                  h('td', null, backup.fileName),
                  h('td', null, String(backup.bytes ?? '—')),
                  h('td', null, backup.sha256 ? backup.sha256.slice(0, 16) + '…' : 'invalid')))))),
        h('small', null, t('backupRestoreHint'))))
      : null,
  );
  return overlay;
}

function isLifeSubject(subject) {
  if (!subject || typeof subject !== 'object' || subject.pkg?.name !== '@fg-lab/amadeus-life') return false;
  if (subject.kind === 'bundle') return true;
  if (subject.kind === 'row') {
    return subject.row?.moduleName === '@fg-lab/amadeus-life' || subject.row?.rowId === 'amadeus-life';
  }
  return subject.kind === 'item';
}

function DetailCard({ ctx }) {
  ensureStyles();
  const lang = locale();
  const t = React.useCallback((key) => (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key, [lang]);
  const [snapshot, setSnapshot] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [health, setHealth] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const formRef = React.useRef(null);

  const loadStatus = React.useCallback(async () => {
    try {
      const status = await api('/status');
      setHealth(status);
    } catch (e) {
      setHealth(null);
      setError(e.message);
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    let form;
    try {
      form = ctx.configForms.get(NS);
      formRef.current = form;
    } catch {
      setError(t('settingsUnavailable'));
    }
    if (!form) return () => { alive = false; };
    const sync = () => {
      if (!alive) return;
      const next = form.getSnapshot();
      setSnapshot(next);
      setDraft((previous) => {
        if (previous === null || previous.status !== 'ready') return draftFromSnapshot(next);
        if (!isDirty(previous, next, DETAIL_FIELDS)) return draftFromSnapshot(next);
        return { ...previous, revision: next.revision, writable: next.writable, status: next.status };
      });
    };
    sync();
    const unsubscribe = form.subscribe(sync);
    loadStatus();
    return () => {
      alive = false;
      unsubscribe();
      try { form.dispose(); } catch { /* ignore */ }
    };
  }, [ctx, loadStatus, t]);

  if (!draft || !snapshot || snapshot.status === 'loading') {
    return h('div', { 'data-amadeus-life': 'true', className: 'amadeus-life-detail' },
       h('h3', null, t('basicConfig')), h('p', { role: 'status' }, t('loadingForm')),
      error ? h('div', { className: 'message error', role: 'alert' }, error) : null);
  }
  if (snapshot.status === 'unavailable') {
    return h('div', { 'data-amadeus-life': 'true', className: 'amadeus-life-detail' },
       h('h3', null, t('basicConfig')), h('p', { role: 'alert' }, t('settingsUnavailable')));
  }

  const change = (key, value) => {
    setDraft((previous) => setDraftValue(previous, key, value));
    setMessage('');
    setError('');
  };
  const dirty = isDirty(draft, snapshot, DETAIL_FIELDS);
  const errors = validateAll(draft.values, DETAIL_FIELDS);
  const hasErrors = Object.keys(errors).length > 0;
  const disabled = busy || draft.writable !== true;
  const save = async () => {
    const form = formRef.current;
    const accepted = form?.getSnapshot();
    if (!form || !accepted) return;
    if (hasErrors) return setError(t('invalidFields'));
    setBusy(true); setError('');
    try {
      const ops = buildSetOps(draft, accepted, DETAIL_FIELDS);
      if (ops.length === 0) { setMessage(t('unchanged')); return; }
      const ok = await form.mutate(ops, accepted.revision);
      if (!ok) setError(t('conflict'));
      else { setMessage(t('saved')); await loadStatus(); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    const accepted = formRef.current?.getSnapshot();
    if (accepted) setDraft(draftFromSnapshot(accepted));
    setError(''); setMessage('');
  };

  return h('div', { 'data-amadeus-life': 'true', className: 'amadeus-life-detail' },
        h('h3', null, t('basicConfig')),
    h('div', { className: 'chips' },
      h('span', { className: 'chip ' + (health?.health?.state === 'ok' ? 'ok' : 'warn') },
        t('health') + ': ' + (health?.health?.state || t('unavailable'))),
      health?.setup?.state ? h('span', { className: 'chip ' + (health.setup.state === 'ready' ? 'ok' : 'warn') },
        t('setupState') + ': ' + health.setup.state) : null),
    error ? h('div', { className: 'message error', role: 'alert' }, error) : null,
    hasErrors ? h('div', { className: 'message error', role: 'alert' }, t('invalidFields')) : null,
    message ? h('div', { className: 'message success', role: 'status' }, message) : null,
    h(ConfigFields, { fields: DETAIL_FIELDS, draft, change, disabled, lang, t, errors }),
    h('div', { className: 'actions' },
      h('button', { type: 'button', className: 'primary', onClick: save, disabled: disabled || hasErrors || !dirty },
        busy ? t('saving') : t('save')),
      h('button', { type: 'button', onClick: cancel, disabled: busy || !dirty }, t('cancel')),
      h('small', null, t('saved'))));
}

return {
  inject: ['slots', 'configForms'],
  apply(ctx) {
    let settingsActive;
    let detailActive;
    const activate = () => {
      if (settingsActive) return settingsActive.dispose;
      let dispose = () => {};
      try {
        dispose = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'amadeus-life',
              order: 24,
              label: () => (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh')
                ? 'Amadeus 生活'
                : 'Amadeus Life'),
            },
            () => h(Panel, { ctx }),
          ));
      } catch (error) {
        console.error('[amadeus-life] settings.section unavailable', error);
      }
      // whileServed expects the registration disposer. Returning it is what
      // makes repeated mirror syncs idempotent and makes unload/disable cleanup
      // both contributions; a bare fire-and-forget register duplicates them.
      const disposal = () => {
        if (!settingsActive || settingsActive.dispose !== disposal) return;
        settingsActive = undefined;
        try { dispose(); } catch { /* already disposed */ }
      };
      settingsActive = { dispose: disposal };
      return disposal;
    };
    const activateDetail = () => {
      if (detailActive) return detailActive.dispose;
      const disposers = [];
      try {
        disposers.push(ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            { name: 'plugins.detail.section', id: 'amadeus-life-basic-config', order: 30 },
            (props) => (isLifeSubject(props?.subject) ? h(DetailCard, { ctx }) : null),
          )));
      } catch (error) {
        console.error('[amadeus-life] plugins.detail.section unavailable', error);
      }
      try {
        disposers.push(ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: '@fg-lab/amadeus-life#amadeus-life' },
            (props) => (props?.view === 'summary' ? h(DetailCard, { ctx }) : h(Panel, { ctx })),
          )));
      } catch (error) {
        console.error('[amadeus-life] plugins.row.config unavailable', error);
      }
      const disposal = () => {
        if (!detailActive || detailActive.dispose !== disposal) return;
        detailActive = undefined;
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch { /* already disposed */ }
        }
      };
      detailActive = { dispose: disposal };
      return disposal;
    };
    if (ctx.configForms && typeof ctx.configForms.whileServed === 'function') {
      ctx.effect(() => ctx.configForms.whileServed([NS], activate), 'amadeus-life: settings page');
      ctx.effect(() => ctx.configForms.whileServed([NS], activateDetail), 'amadeus-life: plugin config');
    } else {
      ctx.effect(() => activate(), 'amadeus-life: settings page');
      ctx.effect(() => activateDetail(), 'amadeus-life: plugin config');
    }
  },
};

  }
});

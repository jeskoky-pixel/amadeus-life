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
export function acceptedValues(snapshot) {
  return snapshot && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
}

/**
 * @param {Record<string, any>|undefined} snapshot - config form snapshot.
 * @returns {Record<string, any>} initial draft.
 */
export function draftFromSnapshot(snapshot) {
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
export function rebaseDraft(draft, revision) {
  return { ...draft, revision };
}

/**
 * @param {Record<string, any>} values - current values.
 * @param {Record<string, any>} accepted - accepted values.
 * @param {Array<Record<string, any>>} fields - field metadata.
 * @returns {string[]} dirty field keys.
 */
export function dirtyFields(values, accepted, fields) {
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
export function isDirty(draft, snapshot, fields) {
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
export function hasRevisionConflict(previousDraft, nextSnapshot, fields, initialized) {
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
export function buildSetOps(draft, snapshot, fields) {
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
export function buildUnsetAllOps(fields) {
  return fields.map((field) => ({ op: 'unset', path: [field.key] }));
}

/**
 * Set one draft value without mutating the previous object.
 * @param {Record<string, any>} draft - draft.
 * @param {string} key - field.
 * @param {unknown} value - value.
 * @returns {Record<string, any>} next draft.
 */
export function setDraftValue(draft, key, value) {
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
export function validateField(field, value) {
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
        !/^(?:session-[A-Za-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(entry)
      ) return 'invalidSessionId';
    }
    return null;
  }
  if (field.type === 'string') {
    if (typeof actual !== 'string') return 'invalidString';
    if (field.max !== undefined && actual.length > field.max) return 'tooLong';
    if (field.key === 'idleTargetSessionId' && actual !== '' && !/^(?:session-[A-Za-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(actual)) {
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
export function validateAll(values, fields) {
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
export function clampFieldValue(field, input) {
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
export function draftConfig(values, fields) {
  const output = {};
  for (const field of fields) output[field.key] = values[field.key];
  return output;
}

/**
 * @param {number} total - total rows.
 * @param {number} pageSize - page size.
 * @returns {number} page count, at least 1.
 */
export function pageCount(total, pageSize) {
  return Math.max(1, Math.ceil(Number(total) / Math.max(1, Number(pageSize))));
}

/**
 * @param {number} page - requested page.
 * @param {number} total - rows.
 * @param {number} pageSize - size.
 * @returns {number} clamped page.
 */
export function clampPage(page, total, pageSize) {
  return Math.min(pageCount(total, pageSize), Math.max(1, Math.floor(Number(page) || 1)));
}

/**
 * @param {number} value - number.
 * @returns {string} signed one-decimal display.
 */
export function signed(value) {
  const n = Math.round(Number(value) * 10) / 10;
  return n > 0 ? `+${n}` : String(n);
}

/**
 * @param {Record<string, unknown>} deltas - state deltas.
 * @returns {string} compact delta text.
 */
export function deltaText(deltas, lang = 'zh') {
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
export function sourceLabel(source, lang) {
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
export function trustLabel(trust, lang) {
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
export function previewText(preview, lang) {
  if (!preview) return '';
  const before = preview.before ?? {};
  const after = preview.after ?? {};
  if (lang === 'en') {
    return `Predicted after one event: Mood ${signed(before.mood)} → ${signed(after.mood)}, Energy ${before.energy} → ${after.energy}, Curiosity ${before.curiosity} → ${after.curiosity}. This preview does not write the database.`;
  }
  return `单个事件后的预计变化：心情 ${signed(before.mood)} → ${signed(after.mood)}，精力 ${before.energy} → ${after.energy}，好奇 ${before.curiosity} → ${after.curiosity}。预览不会写入数据库。`;
}

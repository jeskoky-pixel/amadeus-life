/**
 * A small, dependency-free Standard Schema implementation for State's Config.
 *
 * DSH's Loader validates a plugin's exported `Config` through
 * `Config['~standard'].validate`, and the Settings service introspects the
 * schema through `toJSON()` plus `meta`/`dict`.  This module implements exactly
 * that public protocol (including the shared cosmokit volatile reference
 * protocol) so the plugin has no runtime dependency on host packages, while
 * still producing Schemastery-compatible JSON for the native settings form.
 *
 * This is original interoperability code, not a copy of Schemastery.
 */

const WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * @template T
 * @param {T} value - validated, JSON-shaped config value.
 * @returns {{get: () => T}} frozen stable reference.
 */
export function createVolatile(value) {
  let current = freezeSnapshot(value);
  return Object.freeze({
    get: () => current,
    [WRITE]: (next) => {
      current = freezeSnapshot(next);
    },
  });
}

/**
 * Whether a value implements the shared volatile reference protocol.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a volatile reference.
 */
export function isVolatile(value) {
  return typeof value === 'object' && value !== null && WRITE in value;
}

/**
 * Freeze a detached JSON-shaped snapshot.
 * @param {unknown} value - input value.
 * @param {Set<object>} [ancestors] - cycle guard.
 * @returns {unknown} frozen snapshot.
 */
function freezeSnapshot(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new TypeError('config cannot contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeSnapshot(item, ancestors)));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('config objects must be plain objects or arrays');
    }
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeSnapshot(item, ancestors)])),
    );
  } finally {
    ancestors.delete(value);
  }
}

let nextUid = 0;

class SchemaError extends Error {
  /**
   * @param {string} message - validation message.
   * @param {string[]} path - field path.
   */
  constructor(message, path) {
    super(message);
    this.name = 'SchemaError';
    this.path = path;
  }
}

/**
 * One schema node.
 */
class Node {
  /**
   * @param {string} type - Schemastery-compatible node type.
   * @param {Record<string, unknown>} [init] - node fields.
   */
  constructor(type, init = {}) {
    this.type = type;
    this.meta = {};
    for (const [key, value] of Object.entries(init)) {
      if (key !== 'meta') this[key] = value;
    }
    if (init.meta !== undefined) this.meta = { ...init.meta };
    // Stable numeric identity used by the official Schemastery `{uid, refs}`
    // serialization envelope. Non-enumerable so it never leaks into the ref
    // body; nested schema positions serialize to these numbers.
    Object.defineProperty(this, 'uid', { value: nextUid++, enumerable: false, writable: false });
  }

  /** @param {unknown} value - default value. */
  default(value) {
    this.meta.default = value;
    return this;
  }

  /** @param {string|Record<string,string>} text - form description. */
  description(text) {
    this.meta.description = text;
    return this;
  }

  /** @param {number} value - minimum. */
  min(value) {
    this.meta.min = value;
    return this;
  }

  /** @param {number} value - maximum. */
  max(value) {
    this.meta.max = value;
    return this;
  }

  /** @param {number} value - step for form controls. */
  step(value) {
    this.meta.step = value;
    return this;
  }

  /** @param {string} role - optional form role. */
  role(role, extra = {}) {
    this.meta.role = role;
    this.meta = { ...this.meta, ...extra };
    return this;
  }

  /** Mark this field as a live, in-place config reference. */
  volatile() {
    if (this.meta.volatile) throw new TypeError('volatile schema is already wrapped');
    this.meta.volatile = true;
    return this;
  }

  /**
   * Serialize using the official Schemastery `{uid, refs}` envelope.
   *
   * The official rehydrator (`new Schema(serialized)`) expects every nested
   * schema position (`dict` values, `list` entries, `inner`, `sKey`) to be a
   * numeric uid key into `refs`, not an inline object. Inline nested objects
   * made the real DSH settings form stay in its loading state.
   * @returns {number|Record<string, unknown>} uid when nested, envelope at root.
   */
  toJSON() {
    const active = globalThis.__schemastery_refs__;
    if (active) {
      if (active[this.uid] === undefined) active[this.uid] = serializeNode(this);
      return this.uid;
    }
    const refs = {};
    globalThis.__schemastery_refs__ = refs;
    try {
      refs[this.uid] = serializeNode(this);
      return { uid: this.uid, refs };
    } finally {
      globalThis.__schemastery_refs__ = undefined;
    }
  }

  /**
   * Validate and normalize a value.
   * @param {unknown} value - raw value.
   * @returns {unknown} validated value (volatile refs for volatile fields).
   */
  validate(value) {
    try {
      return resolve(this, value, []);
    } catch (error) {
      if (error instanceof SchemaError) return { issues: [{ message: error.message, path: error.path }] };
      throw error;
    }
  }

  get ['~standard']() {
    return {
      version: 1,
      vendor: 'schemastery',
      validate: (value) => {
        try {
          return { value: resolve(this, value, []) };
        } catch (error) {
          if (error instanceof SchemaError) return { issues: [{ message: error.message, path: error.path }] };
          throw error;
        }
      },
    };
  }
}

/**
 * Serialize one ref body while nested schema positions are replaced by their
 * numeric uids through `Node.toJSON()`.
 * @param {Node} node - schema node.
 * @returns {Record<string, unknown>} ref body.
 */
function serializeNode(node) {
  return JSON.parse(JSON.stringify({ ...node }));
}

/**
 * @param {Node} node - schema node.
 * @param {unknown} value - raw value.
 * @param {string[]} path - current path.
 * @returns {unknown} processed value.
 */
function resolve(node, value, path) {
  const target = value === undefined ? node.meta.default : value;
  if (target === undefined) {
    if (node.meta.required !== false) throw new SchemaError(`missing required value at ${path.join('.') || '$'}`, path);
    return undefined;
  }
  const validated = resolvePlain(node, target, path);
  if (node.meta.volatile) return createVolatile(validated);
  return validated;
}

/**
 * @param {Node} node - schema node.
 * @param {unknown} value - non-default value.
 * @param {string[]} path - current path.
 * @returns {unknown} processed value without volatile wrapping.
 */
function resolvePlain(node, value, path) {
  switch (node.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SchemaError(`expected object at ${path.join('.') || '$'}`, path);
      }
      const result = {};
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        const childValue = resolve(child, Reflect.get(value, key), [...path, key]);
        if (childValue !== undefined) result[key] = childValue;
      }
      return result;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new SchemaError(`expected array at ${path.join('.') || '$'}`, path);
      const min = node.meta.min ?? 0;
      const max = node.meta.max ?? Number.POSITIVE_INFINITY;
      if (value.length < min || value.length > max) {
        throw new SchemaError(`array length out of range at ${path.join('.') || '$'}`, path);
      }
      return value.map((entry, index) => resolve(node.inner, entry, [...path, String(index)]));
    }
    case 'string': {
      if (typeof value !== 'string') throw new SchemaError(`expected string at ${path.join('.') || '$'}`, path);
      const min = node.meta.min ?? 0;
      const max = node.meta.max ?? Number.POSITIVE_INFINITY;
      if (value.length < min || value.length > max) {
        throw new SchemaError(`string length out of range at ${path.join('.') || '$'}`, path);
      }
      if (node.meta.pattern instanceof RegExp && !node.meta.pattern.test(value)) {
        throw new SchemaError(`string does not match pattern at ${path.join('.') || '$'}`, path);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new SchemaError(`expected finite number at ${path.join('.') || '$'}`, path);
      }
      const min = node.meta.min ?? Number.NEGATIVE_INFINITY;
      const max = node.meta.max ?? Number.POSITIVE_INFINITY;
      if (value < min || value > max) {
        throw new SchemaError(`number out of range at ${path.join('.') || '$'}`, path);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new SchemaError(`expected boolean at ${path.join('.') || '$'}`, path);
      return value;
    }
    case 'const': {
      if (value !== node.value) {
        throw new SchemaError(`expected ${JSON.stringify(node.value)} at ${path.join('.') || '$'}`, path);
      }
      return value;
    }
    case 'union': {
      const messages = [];
      for (const candidate of node.list ?? []) {
        try {
          return resolvePlain(candidate, value, path);
        } catch (error) {
          if (error instanceof SchemaError) messages.push(error.message);
          else throw error;
        }
      }
      throw new SchemaError(
        `expected one of ${(node.list ?? []).map((item) => JSON.stringify(item.value)).join(', ')} at ${path.join('.') || '$'}`,
        path,
      );
    }
    case 'dict': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SchemaError(`expected object at ${path.join('.') || '$'}`, path);
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, resolve(node.inner, entry, [...path, key])]),
      );
    }
    default:
      return value;
  }
}

function numberNode() {
  return new Node('number');
}
function stringNode() {
  return new Node('string');
}
function booleanNode() {
  return new Node('boolean');
}
function constNode(value) {
  return new Node('const', { value });
}
function unionNode(list) {
  return new Node('union', { list });
}
function objectNode(dict) {
  return new Node('object', { dict });
}
function arrayNode(inner) {
  return new Node('array', { inner });
}

/** Public schema factory. */
export const Schema = Object.freeze({
  object: objectNode,
  array: arrayNode,
  string: stringNode,
  number: numberNode,
  boolean: booleanNode,
  const: constNode,
  union: unionNode,
});

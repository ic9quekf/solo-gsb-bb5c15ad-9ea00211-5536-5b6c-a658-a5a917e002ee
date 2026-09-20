"use strict";

/**
 * Historical sample migration.
 *
 * The user pastes up to MAX_SAMPLES old samples (e.g. traffic captured
 * against the baseline contract) and configures a list of mappings
 *
 *   { from: "<source JSON Pointer>",
 *     to:   "<target JSON Pointer>",
 *     default?: <optional JSON value> }
 *
 * The backend first PLANS the run (pointer parsing + cross-mapping overlap
 * checks, independent of any concrete sample), then applies the plan to
 * every sample atomically:
 *
 *   - a reachable source is MOVED (cut from its old location, pasted at the
 *     target);
 *   - a missing source with a `default` FILLS the target with that value;
 *   - a missing source without a default is left untouched (no-op);
 *   - parent/child source overlap is resolved by walking deepest first, so
 *     each value lands at exactly one place (a moved parent no longer
 *     contains a child that was moved out separately);
 *   - array elements are removed from the highest index first (indexes of
 *     not-yet-removed siblings stay valid) and targets support "-" append
 *     plus RFC-6902-style concrete indexes (index > length is a conflict);
 *   - a target that already holds a value refuses the MOVE (never silently
 *     overwrites); a FILL keeps the existing value; structural mismatches
 *     (writing a key into an array, descending through a scalar, an
 *     out-of-range intermediate index, ...) are conflicts too.
 *
 * Any conflict leaves that sample byte-for-byte unchanged (the whole plan
 * is applied to a throw-away clone first) and reports a human-readable
 * reason. Every resulting document is then validated with Ajv against the
 * CURRENT schema; the original document is also checked against both
 * schemas for context. Results are summarized as migrated / conflict /
 * no-op together with valid/invalid counts, and `successfulSamples` carries
 * exactly the migrated documents that pass the current schema.
 *
 * Configuration problems (illegal pointers, duplicated/nesting source and
 * target paths across different mappings, source/target cross nesting)
 * refuse the whole run with 422 and per-mapping `mappingErrors`.
 */

const Ajv2020 = require("ajv/dist/2020").default;
const { parsePointer } = require("./variant");

const MAX_SAMPLES = 200;
const MAX_MAPPINGS = 20;

const POINTER_HINT =
  'JSON Pointer 须以 "/" 开头（空串 "" 表示样本根），"~" 仅允许写作 ~0（表示 ~）或 ~1（表示 /），目标端可用单段 "-" 表示向数组追加元素';

// RFC 6901 array index: "0" or digits without a leading zero.
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;
const APPEND = "-";

// Marks a document location that was emptied (only possible for the root,
// when the sole mapping moves the whole sample somewhere). JSON values can
// never carry this symbol.
const EMPTY = Symbol("empty");

const ajv = new Ajv2020({ allErrors: true, strict: false });

const clone = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** True when `a` equals `b` or is an ancestor path of `b`. */
function isPrefixOrEqual(a, b) {
  return a.length <= b.length && a.every((segment, i) => segment === b[i]);
}

function equalPath(a, b) {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * Read a value at parsed segments. Root ("") is always found. Returns
 * { found: false } when a key is missing, an index is out of range, "-"
 * addresses an append slot (never readable), or traversal hits a scalar.
 */
function readAt(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= node.length) return { found: false };
      node = node[index];
    } else if (isPlainObject(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) return { found: false };
      node = node[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: node };
}

/** Remove the location addressed by segments; returns the new root. */
function removeAt(root, segments) {
  if (segments.length === 0) return EMPTY; // whole sample moved away
  const parent = readAt(root, segments.slice(0, -1));
  if (!parent.found) return root; // defensive: planner ordering prevents this
  const last = segments[segments.length - 1];
  if (Array.isArray(parent.value)) {
    const index = Number(last);
    if (index < parent.value.length) parent.value.splice(index, 1);
  } else if (isPlainObject(parent.value)) {
    delete parent.value[last];
  }
  return root;
}

/**
 * Numeric-aware descending segment comparison used for same-depth source
 * ordering: array siblings are removed from the highest index first
 * ("/a/10" before "/a/2" before "/a/0"), so earlier removals never shift
 * the indexes of later ones.
 */
function compareSegmentDesc(a, b) {
  if (ARRAY_INDEX.test(a) && ARRAY_INDEX.test(b)) return Number(b) - Number(a);
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/** Deepest source first; ties compare from the leaf upward, then input order. */
function compareSourceOps(a, b) {
  if (a.from.length !== b.from.length) return b.from.length - a.from.length;
  const depth = a.from.length;
  for (let i = depth - 1; i >= 0; i -= 1) {
    const cmp = compareSegmentDesc(a.from[i], b.from[i]);
    if (cmp !== 0) return cmp;
  }
  return a.index - b.index;
}

/** Shallowest target first (containers are created before their children). */
function compareTargetOps(a, b) {
  if (a.to.length !== b.to.length) return a.to.length - b.to.length;
  return a.index - b.index;
}

/**
 * Validate the mapping configuration independent of concrete samples.
 * Returns [{ index, from, to, reason }] (empty list == plan is usable).
 */
function planMappings(mappings) {
  const errors = [];
  const parsed = mappings.map((mapping, index) => {
    const from = parsePointer(mapping.from);
    const to = parsePointer(mapping.to);
    if (from === null || to === null) {
      errors.push({
        index,
        from: mapping.from,
        to: mapping.to,
        reason: `源或目标 Pointer 非法。${POINTER_HINT}`,
      });
      return null;
    }
    // Same source and target is only meaningful as a "self fill": keep the
    // existing value, insert the default when the path is missing. Without
    // a default it does nothing, so it is rejected as misconfiguration.
    const selfFill =
      equalPath(from, to) && Object.prototype.hasOwnProperty.call(mapping, "default");
    if (equalPath(from, to) && !Object.prototype.hasOwnProperty.call(mapping, "default")) {
      errors.push({
        index,
        from: mapping.from,
        to: mapping.to,
        reason: `源路径与目标路径相同（${mapping.from === "" ? "(root)" : mapping.from}）且未配置默认值，该映射不会产生任何变化；如需补默认值请填写默认值`,
      });
      return null;
    }
    return { index, from, to, rawFrom: mapping.from, rawTo: mapping.to, selfFill };
  });

  const valid = parsed.filter(Boolean);

  valid.forEach((op, pos) => {
    const earlier = valid.slice(0, pos);
    // Exact duplicates (source or target) make the result ambiguous. A
    // same-path "self fill" occupies its one path twice, so it collides with
    // any other mapping using that source or target.
    const dupFrom = earlier.find((other) => equalPath(other.from, op.from));
    if (dupFrom) {
      errors.push({
        index: op.index,
        from: op.rawFrom,
        to: op.rawTo,
        reason: `源路径与映射 ${dupFrom.index + 1}（${dupFrom.rawFrom === "" ? "(root)" : dupFrom.rawFrom}）重复`,
      });
      return;
    }
    const dupTo = earlier.find((other) => {
      if (!equalPath(other.to, op.to)) return false;
      // Several moves may append to the same array with "-": each push
      // claims a distinct slot, so the targets are not really duplicated.
      if (op.to.length > 0 && op.to[op.to.length - 1] === APPEND) return false;
      return true;
    });
    if (dupTo) {
      errors.push({
        index: op.index,
        from: op.rawFrom,
        to: op.rawTo,
        reason: `目标路径与映射 ${dupTo.index + 1}（${dupTo.rawTo === "" ? "(root)" : dupTo.rawTo}）重复（向同一数组追加多个元素请使用 "-"）`,
      });
      return;
    }
    if (op.selfFill) return; // same source and target path -> never crosses another
    // Cross nesting: a SOURCE of one mapping is an ancestor of the OTHER
    // mapping's TARGET (checked in both pair orientations). The moved tree
    // and the write location would then be the same nodes, so an atomic
    // result is not well-defined. Pure source-parent/child overlap
    // (source nesting another source) and nested targets (target nesting
    // another target) stay allowed: moves resolve deepest-first and nested
    // writes merge with their created parents. Root ("") is an ancestor of
    // every path, so a root source or root target can only appear as the
    // sole mapping.
    const covering = earlier.find((other) => {
      if (other.selfFill) return false;
      // Cross means a path from the SOURCE side of one mapping is an
      // ancestor of a path on the TARGET side of the other (either pair
      // direction). Same-side nesting (source/source, target/target) is
      // intentionally allowed.
      const sourceCoversTarget =
        isPrefixOrEqual(op.from, other.to) || isPrefixOrEqual(other.from, op.to);
      const targetCoversSource =
        isPrefixOrEqual(op.to, other.from) || isPrefixOrEqual(other.to, op.from);
      return sourceCoversTarget || targetCoversSource;
    });
    if (covering) {
      errors.push({
        index: op.index,
        from: op.rawFrom,
        to: op.rawTo,
        reason: `与映射 ${covering.index + 1}（${
          covering.rawFrom === "" ? "(root)" : covering.rawFrom
        } → ${covering.rawTo === "" ? "(root)" : covering.rawTo}）的源/目标路径嵌套交叉，无法原子执行；根路径 "" 只能作为唯一映射`,
      });
    }
  });

  errors.sort((a, b) => a.index - b.index);
  return errors;
}

/**
 * Recursively write `value` at `segments` inside `node`. Missing
 * intermediate containers are created (an array when the next segment is an
 * index / "-", an object otherwise). Returns
 *   { node }                on success
 *   { node, skipped: true }  for a FILL whose concrete target exists
 *   { conflict: reason }     for structural mismatches / MOVE overwrites
 */
function writeAt(node, segments, value, kind, targetPointer) {
  if (segments.length === 0) {
    if (node === EMPTY) return { node: value };
    if (kind === "fill") return { node, skipped: true };
    return { conflict: "样本根节点已存在值，无法覆盖移动" };
  }
  // Whole-sample move created an empty document: materialize the root
  // container (array for an index / "-" first segment, object otherwise).
  if (node === EMPTY) {
    const head = segments[0];
    const created = head === APPEND || ARRAY_INDEX.test(head) ? [] : {};
    const outcome = writeAt(created, segments, value, kind, targetPointer);
    if (outcome.conflict) return outcome;
    return { node: outcome.node };
  }
  if (node === null || node === undefined) {
    // Missing holders are created by the object/array branches below; an
    // explicit JSON null in the middle is a scalar and cannot be traversed.
    return { conflict: `目标中间路径遇到 null，无法继续写入 ${targetPointer}` };
  }

  const [segment, ...rest] = segments;
  const nextIsIndex = rest.length > 0 && (rest[0] === APPEND || ARRAY_INDEX.test(rest[0]));

  if (Array.isArray(node)) {
    if (segment === APPEND) {
      if (rest.length > 0) {
        return { conflict: `目标路径 ${targetPointer} 的 "-" 段后不能再嵌套路径` };
      }
      node.push(value);
      return { node };
    }
    if (!ARRAY_INDEX.test(segment)) {
      return {
        conflict: `目标父级是数组，"${segment}" 不是合法下标（0 起、无前导 0），也不是追加符 "-"`,
      };
    }
    const index = Number(segment);
    if (rest.length === 0) {
      // Leaf slot: exactly-length appends a new element; beyond-length has
      // a gap and is refused.
      if (index < node.length) {
        if (kind === "fill") return { node, skipped: true };
        return { conflict: `目标位置 ${targetPointer} 已存在值，移动会覆盖已有数据` };
      }
      if (index === node.length) {
        node.push(value);
        return { node };
      }
      return { conflict: `数组下标 ${index} 越界（当前长度 ${node.length}，可用追加符 "-" 或不大于长度的下标）` };
    }
    // Intermediate slot: descending into the element being appended.
    if (index === node.length) {
      const created = rest[0] === APPEND || ARRAY_INDEX.test(rest[0]) ? [] : {};
      const outcome = writeAt(created, rest, value, kind, targetPointer);
      if (outcome.conflict) return outcome;
      node.push(outcome.node);
      return { node };
    }
    if (index > node.length) {
      return { conflict: `目标中间路径下标 ${index} 越界（数组长度 ${node.length}），无法进入下一级` };
    }
    const child = node[index];
    if (!isPlainObject(child) && !Array.isArray(child)) {
      return { conflict: `目标中间路径 ${targetPointer} 的第 ${index + 1} 个元素是标量，无法继续向下写入` };
    }
    const inner = writeAt(child, rest, value, kind, targetPointer);
    if (inner.conflict) return inner;
    node[index] = inner.node;
    return { node };
  }

  if (isPlainObject(node)) {
    if (segment === APPEND) {
      return { conflict: `目标父级 ${targetPointer} 是对象，"-" 只能用于向数组追加元素` };
    }
    if (rest.length === 0) {
      if (Object.prototype.hasOwnProperty.call(node, segment)) {
        if (kind === "fill") return { node, skipped: true };
        return { conflict: `目标位置 ${targetPointer} 已存在值，移动会覆盖已有数据` };
      }
      node[segment] = value;
      return { node };
    }
    if (!Object.prototype.hasOwnProperty.call(node, segment)) {
      node[segment] = nextIsIndex ? [] : {};
    }
    const child = node[segment];
    if (!isPlainObject(child) && !Array.isArray(child)) {
      return { conflict: `目标中间路径经过标量值（键 "${segment}"），无法继续写入 ${targetPointer}` };
    }
    const outcome = writeAt(child, rest, value, kind, targetPointer);
    if (outcome.conflict) return outcome;
    node[segment] = outcome.node;
    return { node };
  }

  return { conflict: `目标中间路径经过标量值，无法继续写入 ${targetPointer}` };
}

/**
 * Apply the planned mappings to one sample atomically. The plan is applied
 * to a deep clone; any conflict discards it.
 *
 * @returns {{ status: "migrated"|"conflict"|"noop",
 *             after: any | null,
 *             reason: string | null,
 *             operations: Array<object> }}
 */
function migrateOne(sample, plan) {
  const operations = plan.map((op) => {
    const source = readAt(sample, op.from);
    if (op.selfFill) {
      // Same path with a default: keep an existing value, fill when absent.
      if (source.found) {
        return {
          ...op,
          kind: "keep",
          status: "skipped",
          value: undefined,
          detail: `路径 ${op.rawFrom === "" ? "(root)" : op.rawFrom} 已有值，保留原值`,
        };
      }
      return {
        ...op,
        kind: "fill",
        status: "pending",
        value: clone(op.defaultValue),
        detail: null,
      };
    }
    if (source.found) {
      return { ...op, kind: "move", status: "pending", value: undefined, detail: null };
    }
    if (op.hasDefault) {
      return {
        ...op,
        kind: "fill",
        status: "pending",
        value: clone(op.defaultValue),
        detail: null,
      };
    }
    return {
      ...op,
      kind: "noop",
      status: "noop",
      value: undefined,
      detail: `源路径 ${op.rawFrom === "" ? "(root)" : op.rawFrom} 缺失且未配置默认值，跳过`,
    };
  });

  let doc = clone(sample);

  // Phase 1 — moves, deepest source first. Each value is read from the
  // working document AFTER deeper moves, so a moved parent does not carry
  // children that were migrated out separately.
  const moves = operations.filter((op) => op.kind === "move").sort(compareSourceOps);
  for (const op of moves) {
    const current = readAt(doc, op.from);
    if (!current.found) {
      return conflict(operations, op, "规划后的源路径在执行时缺失，无法移动");
    }
    op.value = clone(current.value);
    doc = removeAt(doc, op.from);
    op.status = "extracted";
  }

  // Phase 2 — writes, shallowest target first. Self-fills that found an
  // existing value are already finalized ("keep") and never write.
  const writes = operations
    .filter((op) => op.kind !== "noop" && op.kind !== "keep")
    .sort(compareTargetOps);
  for (const op of writes) {
    // Root target: a move replaces the whole document (only possible as the
    // sole mapping — the planner forbids root in combination with others);
    // a root fill always finds an existing value and is a skip.
    if (op.to.length === 0) {
      if (op.kind === "fill") {
        op.status = "skipped";
        op.detail = "目标为样本根且已存在值，保留原值";
        continue;
      }
      doc = op.value;
      op.status = "applied";
      op.detail = `已将 ${op.rawFrom === "" ? "(root)" : op.rawFrom} 的值移动为新的样本根`;
      continue;
    }
    const outcome = writeAt(doc, op.to, op.value, op.kind, op.rawTo === "" ? "(root)" : op.rawTo);
    if (outcome.conflict) {
      return conflict(operations, op, outcome.conflict);
    }
    doc = outcome.node;
    if (op.kind === "fill" && outcome.skipped) {
      op.status = "skipped";
      op.detail = `目标位置 ${op.rawTo === "" ? "(root)" : op.rawTo} 已存在值，保留原值`;
    } else if (op.kind === "fill") {
      op.status = "applied";
      op.detail = `源路径缺失，已在 ${op.rawTo === "" ? "(root)" : op.rawTo} 补入默认值`;
    } else {
      op.status = "applied";
      op.detail = `已将 ${op.rawFrom === "" ? "(root)" : op.rawFrom} 的值移动到 ${
        op.rawTo === "" ? "(root)" : op.rawTo
      }`;
    }
  }

  const applied = operations.filter((op) => op.status === "applied");
  if (applied.length === 0) {
    return { status: "noop", after: null, reason: null, operations: trace(operations) };
  }
  return { status: "migrated", after: doc, reason: null, operations: trace(operations) };
}

/** Build the conflict result: the failing op is flagged, later ops blocked. */
function conflict(operations, failedOp, detail) {
  for (const op of operations) {
    if (op === failedOp) {
      op.status = "conflict";
      op.detail = detail;
    } else if (op.status === "pending" || op.status === "extracted") {
      op.status = "blocked";
      op.detail = "同条样本上一条操作冲突，本操作未执行";
    }
  }
  const reason = `映射 ${failedOp.index + 1}（${failedOp.rawFrom === "" ? "(root)" : failedOp.rawFrom} → ${
    failedOp.rawTo === "" ? "(root)" : failedOp.rawTo
  }）：${detail}；该样本保持原样`;
  return { status: "conflict", after: null, reason, operations: trace(operations) };
}

/** Serializable per-operation trace (values are not echoed here). */
function trace(operations) {
  return operations.map((op) => ({
    index: op.index,
    from: op.rawFrom,
    to: op.rawTo,
    hasDefault: op.hasDefault,
    kind: op.kind, // "move" | "fill" | "keep" | "noop"
    status: op.status, // "applied" | "skipped" | "noop" | "conflict" | "blocked"
    detail: op.detail,
  }));
}

function mapErrors(validate) {
  return (validate.errors || []).map((e) => ({
    path: e.instancePath || "",
    pointer: e.instancePath || "(root)",
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

/**
 * Migrate a historical sample set and validate the resulting documents
 * against the current schema.
 *
 * @returns {{ total: number,
 *            summary: { migrated: number, conflict: number, noop: number,
 *                       valid: number, invalid: number },
 *            samples: Array<object>, successfulSamples: any[] }}
 */
function migrateSamples({ oldSchema, newSchema, samples, mappings }) {
  if (!isPlainObject(oldSchema)) {
    throw Object.assign(new Error("Request body must contain a 'oldSchema' object."), {
      status: 400,
    });
  }
  if (!isPlainObject(newSchema)) {
    throw Object.assign(new Error("Request body must contain a 'newSchema' object."), {
      status: 400,
    });
  }
  if (!Array.isArray(samples)) {
    throw Object.assign(new Error("Request body must contain a 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per migration.`
      ),
      { status: 400 }
    );
  }
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'mappings' array."), {
      status: 400,
    });
  }
  if (mappings.length > MAX_MAPPINGS) {
    throw Object.assign(
      new Error(
        `Too many mappings: got ${mappings.length}, at most ${MAX_MAPPINGS} allowed per migration.`
      ),
      { status: 400 }
    );
  }
  for (const mapping of mappings) {
    if (!isPlainObject(mapping) || typeof mapping.from !== "string" || typeof mapping.to !== "string") {
      throw Object.assign(
        new Error("Every mapping must be an object with string 'from' and 'to' pointers."),
        { status: 400 }
      );
    }
  }

  const mappingErrors = planMappings(mappings);
  if (mappingErrors.length > 0) {
    const message = mappingErrors
      .map((e) => `映射 ${e.index + 1}（${e.from === "" ? "(root)" : e.from} → ${e.to === "" ? "(root)" : e.to}）：${e.reason}`)
      .join("；");
    throw Object.assign(new Error(`${message}。未执行迁移。`), {
      status: 422,
      details: { mappingErrors },
    });
  }

  // The plan is order-independent: overlaps are resolved at execution time
  // by the source-depth / target-depth ordering, not by input order.
  const plan = mappings.map((mapping, index) => {
    const from = parsePointer(mapping.from);
    const to = parsePointer(mapping.to);
    return {
      index,
      from,
      to,
      rawFrom: mapping.from,
      rawTo: mapping.to,
      hasDefault: Object.prototype.hasOwnProperty.call(mapping, "default"),
      defaultValue: mapping.default,
      selfFill: equalPath(from, to) && Object.prototype.hasOwnProperty.call(mapping, "default"),
    };
  });

  let validateOld;
  let validateNew;
  try {
    validateOld = ajv.compile(oldSchema);
    validateNew = ajv.compile(newSchema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const summary = { migrated: 0, conflict: 0, noop: 0, valid: 0, invalid: 0 };
  const results = samples.map((sample, index) => {
    const outcome = migrateOne(sample, plan);

    const baselineValid = validateOld(sample);
    const baseline = {
      valid: baselineValid,
      errors: baselineValid ? [] : mapErrors(validateOld),
    };

    // Conflict/no-op samples keep their original document; migrated ones
    // carry the transformed document.
    const finalDoc = outcome.status === "migrated" ? outcome.after : sample;
    const currentValid = validateNew(finalDoc);
    const current = {
      valid: currentValid,
      errors: currentValid ? [] : mapErrors(validateNew),
    };
    summary[currentValid ? "valid" : "invalid"] += 1;
    summary[outcome.status] += 1;

    return {
      index,
      status: outcome.status,
      reason: outcome.reason,
      operations: outcome.operations,
      before: sample,
      after: outcome.after, // null unless status === "migrated"
      baseline,
      current,
    };
  });

  const successfulSamples = results
    .filter((item) => item.status === "migrated" && item.current.valid)
    .map((item) => item.after);

  return { total: samples.length, summary, samples: results, successfulSamples };
}

module.exports = {
  migrateSamples,
  planMappings,
  MAX_SAMPLES,
  MAX_MAPPINGS,
  POINTER_HINT,
};

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateSamples, planMappings, MAX_SAMPLES, MAX_MAPPINGS } = require("../migrate");

const OBJECT = {
  type: "object",
  properties: {
    id: { type: "integer" },
    mobile: { type: "string" },
    vip: { type: "boolean" },
  },
  required: ["id", "mobile"],
};

function run(samples, mappings, { oldSchema = OBJECT, newSchema = OBJECT } = {}) {
  return migrateSamples({ oldSchema, newSchema, samples, mappings });
}

test("moves a source pointer to a missing target and removes the old location", () => {
  const { samples, summary, successfulSamples } = run(
    [{ id: 1, phone: "138" }],
    [{ from: "/phone", to: "/mobile" }]
  );
  assert.equal(summary.migrated, 1);
  assert.equal(summary.conflict, 0);
  assert.deepEqual(samples[0].after, { id: 1, mobile: "138" });
  assert.equal(samples[0].status, "migrated");
  assert.equal(samples[0].current.valid, true);
  assert.deepEqual(successfulSamples, [{ id: 1, mobile: "138" }]);
  // The source document was not mutated.
  assert.deepEqual(samples[0].before, { id: 1, phone: "138" });
});

test("fills the default when the source is missing and keeps an existing value", () => {
  const { samples } = run(
    [{ id: 1 }, { id: 2, mobile: "kept", vip: false }],
    [{ from: "/mobile", to: "/mobile", default: "unknown" }, { from: "/vip", to: "/vip", default: true }]
  );
  assert.deepEqual(samples[0].after, { id: 1, mobile: "unknown", vip: true });
  // Nothing changed in the second sample, so it is a no-op and stays as-is.
  assert.equal(samples[1].status, "noop");
  assert.equal(samples[1].after, null);
  assert.equal(samples[1].before.mobile, "kept"); // existing value is never overwritten
  assert.deepEqual(samples[1].before.vip, false);
  const fill = samples[0].operations.find((op) => op.to === "/mobile");
  assert.equal(fill.kind, "fill");
  assert.equal(fill.status, "applied");
  const keep = samples[1].operations.find((op) => op.to === "/mobile");
  assert.equal(keep.kind, "keep");
  assert.equal(keep.status, "skipped");
});

test("missing source without a default is a no-op; all-noop sample keeps original document", () => {
  const { samples, summary } = run(
    [{ id: 1, mobile: "x" }],
    [{ from: "/phone", to: "/mobile" }]
  );
  assert.equal(summary.noop, 1);
  assert.equal(samples[0].status, "noop");
  assert.equal(samples[0].after, null);
  assert.deepEqual(samples[0].before, { id: 1, mobile: "x" });
  assert.equal(samples[0].operations[0].status, "noop");
});

test("removes array elements deepest-index first so siblings keep the right values", () => {
  const newSchema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "integer" } },
      a: { type: "integer" },
      b: { type: "integer" },
    },
  };
  const { samples } = run(
    [{ tags: [3, 4, 5] }],
    [
      { from: "/tags/2", to: "/b" },
      { from: "/tags/0", to: "/a" },
    ],
    { oldSchema: {}, newSchema }
  );
  assert.equal(samples[0].status, "migrated");
  // Index 2 (5) is cut before index 0 (3); remaining element is 4.
  assert.deepEqual(samples[0].after, { tags: [4], b: 5, a: 3 });
});

test("supports the RFC 6902 '-' append marker on an existing array", () => {
  const newSchema = {
    type: "object",
    properties: {
      xs: { type: "array", items: { type: "integer" } },
    },
  };
  const { samples } = run(
    [{ xs: [1], n: 7 }],
    [{ from: "/n", to: "/xs/-" }],
    { oldSchema: {}, newSchema }
  );
  assert.equal(samples[0].status, "migrated");
  assert.deepEqual(samples[0].after, { xs: [1, 7] });
});

test("appends to an array with '-' across distinct sources, preserving mapping order", () => {
  const newSchema = {
    type: "object",
    properties: {
      src: { type: "array", items: { type: "integer" } },
      dst: { type: "array", items: { type: "integer" } },
    },
  };
  const { samples } = run(
    [{ src: [1], a: 3, b: 4 }],
    [
      { from: "/b", to: "/dst/-" },
      { from: "/a", to: "/dst/-" },
    ],
    { oldSchema: {}, newSchema }
  );
  // Equal-depth writes run in mapping input order: b then a.
  assert.deepEqual(samples[0].after, { src: [1], dst: [4, 3] });
});

test("nested targets merge: child write lands inside the parent moved object", () => {
  const newSchema = {
    type: "object",
    properties: {
      env: { type: "object", properties: { city: { type: "string" } } },
    },
  };
  const { samples } = run(
    [{ meta: { zip: "200000" }, city: "SH" }],
    [
      { from: "/meta", to: "/env" },
      { from: "/city", to: "/env/city" },
    ],
    { oldSchema: {}, newSchema }
  );
  // Shallowest first creates env with the moved meta, then the deeper
  // write places city inside it.
  assert.equal(samples[0].status, "migrated");
  assert.deepEqual(samples[0].after, { env: { zip: "200000", city: "SH" } });
});

test("a parent move landing on an existing nested target conflicts atomically", () => {
  const { samples } = run(
    [{ meta: { zip: "200000" }, env: { city: "SH" } }],
    [
      { from: "/meta", to: "/env" },
      { from: "/x", to: "/env/x" },
    ],
    { oldSchema: {}, newSchema: {} }
  );
  // env already exists in the original document; the deeper write lands
  // first, then the object move onto the occupied env is refused.
  assert.equal(samples[0].status, "conflict");
  assert.match(samples[0].reason, /已存在值/);
  assert.deepEqual(samples[0].before, { meta: { zip: "200000" }, env: { city: "SH" } });
});

test("parent/child source overlap is resolved deepest-first when targets differ", () => {
  const newSchema = {
    type: "object",
    properties: {
      city: { type: "string" },
      meta: { type: "object" },
    },
  };
  const { samples } = run(
    [{ meta: { city: "SH", zip: "200000" } }],
    [
      { from: "/meta/city", to: "/city" },
      { from: "/meta", to: "/metaRest" },
    ],
    { oldSchema: {}, newSchema }
  );
  assert.equal(samples[0].status, "migrated");
  assert.deepEqual(samples[0].after, { metaRest: { zip: "200000" }, city: "SH" });
});

test("a target that already holds a value conflicts and leaves the sample untouched", () => {
  const before = { id: 1, phone: "old", mobile: "existing" };
  const { samples, summary } = run([before], [{ from: "/phone", to: "/mobile" }]);
  assert.equal(summary.conflict, 1);
  assert.equal(samples[0].status, "conflict");
  assert.equal(samples[0].after, null);
  assert.deepEqual(samples[0].before, before);
  assert.match(samples[0].reason, /已存在值/);
  const failed = samples[0].operations.find((op) => op.status === "conflict");
  assert.ok(failed);
});

test("a fill on an existing target keeps the existing value and is a no-op", () => {
  const { samples } = run(
    [{ id: 1, mobile: "kept" }],
    [{ from: "/phone", to: "/mobile", default: "fallback" }]
  );
  assert.equal(samples[0].status, "noop");
  assert.equal(samples[0].after, null);
  assert.deepEqual(samples[0].before, { id: 1, mobile: "kept" });
  const op = samples[0].operations[0];
  assert.equal(op.kind, "fill");
  assert.equal(op.status, "skipped");
});

test("writing through a scalar intermediate is a structural conflict", () => {
  const { samples } = run(
    [{ id: 1, a: 5, b: 1 }],
    [{ from: "/b", to: "/a/deep" }]
  );
  assert.equal(samples[0].status, "conflict");
  assert.match(samples[0].reason, /标量/);
  assert.deepEqual(samples[0].before, { id: 1, a: 5, b: 1 });
});

test("concrete array index above length conflicts; '-' appends instead", () => {
  const tooFar = run([{ xs: [1], n: 9 }], [{ from: "/n", to: "/xs/5" }], {
    oldSchema: {},
    newSchema: {},
  });
  assert.equal(tooFar.samples[0].status, "conflict");
  assert.match(tooFar.samples[0].reason, /越界/);

  const append = run([{ xs: [1], n: 9 }], [{ from: "/n", to: "/xs/-" }], {
    oldSchema: {},
    newSchema: {},
  });
  assert.deepEqual(append.samples[0].after, { xs: [1, 9] });
});

test("'-' cannot address an object parent nor keep nesting", () => {
  const objectParent = run([{ o: {}, n: 1 }], [{ from: "/n", to: "/o/-" }], {
    oldSchema: {},
    newSchema: {},
  });
  assert.equal(objectParent.samples[0].status, "conflict");
  assert.match(objectParent.samples[0].reason, /对象/);

  const nestedAppend = run([{ n: 1 }], [{ from: "/n", to: "/xs/-/y" }], {
    oldSchema: {},
    newSchema: {},
  });
  assert.equal(nestedAppend.samples[0].status, "conflict");
  assert.match(nestedAppend.samples[0].reason, /不能再嵌套/);
});

test("non-numeric segment against an array parent is a conflict", () => {
  const { samples } = run([{ xs: [], n: 1 }], [{ from: "/n", to: "/xs/foo" }], {
    oldSchema: {},
    newSchema: {},
  });
  assert.equal(samples[0].status, "conflict");
  assert.match(samples[0].reason, /合法下标/);
});

test("migrated document failing the current schema is classified invalid but still returned", () => {
  const strict = {
    type: "object",
    properties: { id: { type: "integer" }, mobile: { type: "integer" } },
    required: ["id", "mobile"],
  };
  const { samples, summary, successfulSamples } = migrateSamples({
    oldSchema: {},
    newSchema: strict,
    samples: [{ id: 1, phone: "not-a-number" }],
    mappings: [{ from: "/phone", to: "/mobile" }],
  });
  assert.equal(summary.migrated, 1);
  assert.equal(summary.invalid, 1);
  assert.equal(samples[0].current.valid, false);
  assert.equal(samples[0].current.errors[0].keyword, "type");
  assert.equal(samples[0].current.errors[0].pointer, "/mobile");
  assert.deepEqual(successfulSamples, []);
});

test("conflict sample is validated against both schemas for context", () => {
  const oldS = {
    type: "object",
    properties: { id: { type: "integer" }, phone: { type: "string" } },
    required: ["id", "phone"],
  };
  const { samples } = migrateSamples({
    oldSchema: oldS,
    newSchema: OBJECT,
    samples: [{ id: 1, phone: "x", mobile: "y" }],
    mappings: [{ from: "/phone", to: "/mobile" }],
  });
  assert.equal(samples[0].status, "conflict");
  assert.equal(samples[0].baseline.valid, true);
  assert.deepEqual(samples[0].baseline.errors, []);
  assert.equal(samples[0].current.valid, true);
});

test("moving the whole sample to a new key creates a fresh root container", () => {
  const newSchema = {
    type: "object",
    properties: { payload: { type: "object" } },
  };
  const { samples } = run(
    [{ a: 1, b: [2] }],
    [{ from: "", to: "/payload" }],
    { oldSchema: {}, newSchema }
  );
  assert.equal(samples[0].status, "migrated");
  assert.deepEqual(samples[0].after, { payload: { a: 1, b: [2] } });
});

test("moving a key onto the sample root replaces the document", () => {
  const { samples } = run(
    [{ wrap: { hello: "world" } }],
    [{ from: "/wrap", to: "" }],
    { oldSchema: {}, newSchema: { type: "object" } }
  );
  assert.deepEqual(samples[0].after, { hello: "world" });
});

test("nested target containers are created along the path (array vs object by segment)", () => {
  const newSchema = {
    type: "object",
    properties: { list: { type: "array", items: { type: "object" } } },
  };
  const { samples } = run(
    [{ n: 7 }],
    [{ from: "/n", to: "/list/0/n" }],
    { oldSchema: {}, newSchema }
  );
  assert.deepEqual(samples[0].after, { list: [{ n: 7 }] });
});

test("escaped JSON Pointer segments (~0, ~1) round-trip", () => {
  const newSchema = {
    type: "object",
    properties: { "a/b": { type: "integer" } },
  };
  const { samples } = run(
    [{ "x~y": 3 }],
    [{ from: "/x~0y", to: "/a~1b" }],
    { oldSchema: {}, newSchema }
  );
  assert.deepEqual(samples[0].after, { "a/b": 3 });
});

test("planMappings rejects illegal pointers", () => {
  const errors = planMappings([{ from: "no-slash", to: "/b" }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 0);
  assert.match(errors[0].reason, /Pointer 非法/);
  assert.equal(planMappings([{ from: "/a~2", to: "/b" }]).length, 1);
});

test("planMappings rejects same source or same target duplicates", () => {
  const errors = planMappings([
    { from: "/a", to: "/x" },
    { from: "/a", to: "/y" },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /源路径/);
  const targetDup = planMappings([
    { from: "/a", to: "/x" },
    { from: "/b", to: "/x" },
  ]);
  assert.equal(targetDup.length, 1);
  assert.match(targetDup[0].reason, /目标路径/);
});

test("planMappings rejects source/target cross nesting (both pair orientations)", () => {
  // op1 writes its target INSIDE op2's moved source subtree.
  const a = planMappings([
    { from: "/a", to: "/x" },
    { from: "/b", to: "/a/child" },
  ]);
  assert.equal(a.length, 1);
  assert.match(a[0].reason, /嵌套/);
  // Reverse the pair ordering: same refusal, attributed to the later op.
  const b = planMappings([
    { from: "/b", to: "/a/child" },
    { from: "/a", to: "/x" },
  ]);
  assert.equal(b.length, 1);
});

test("planMappings forbids root source/target combined with other mappings", () => {
  const rootSource = planMappings([
    { from: "", to: "/payload" },
    { from: "/c", to: "/d" },
  ]);
  assert.equal(rootSource.length, 1);
  assert.match(rootSource[0].reason, /根路径/);
  const rootTarget = planMappings([
    { from: "/a", to: "" },
    { from: "/c", to: "/d" },
  ]);
  assert.equal(rootTarget.length, 1);
  assert.match(rootTarget[0].reason, /根路径/);
  // Root alone is fine.
  assert.deepEqual(planMappings([{ from: "", to: "/payload" }]), []);
});

test("planMappings allows source parent/child overlap and nested targets", () => {
  assert.deepEqual(
    planMappings([
      { from: "/meta/city", to: "/city" },
      { from: "/meta", to: "/rest" },
    ]),
    []
  );
  assert.deepEqual(
    planMappings([
      { from: "/a", to: "/env/x" },
      { from: "/b", to: "/env/y" },
    ]),
    []
  );
});

test("planMappings rejects same path without a default but accepts a self fill", () => {
  assert.equal(planMappings([{ from: "/vip", to: "/vip" }]).length, 1);
  assert.deepEqual(planMappings([{ from: "/vip", to: "/vip", default: true }]), []);
});

test("migrateSamples rejects planner errors with 422 and mappingErrors details", () => {
  assert.throws(
    () =>
      run([{ a: 1, c: 2 }], [
        { from: "bad", to: "/x" }, // illegal pointer
        { from: "/a", to: "/x" },
        { from: "/c", to: "/x" }, // duplicate concrete target
      ]),
    (err) =>
      err.status === 422 &&
      Array.isArray(err.details.mappingErrors) &&
      err.details.mappingErrors.length === 2
  );
});

test("migrateSamples validates request shape with 400", () => {
  for (const args of [
    { newSchema: {}, samples: [{}], mappings: [{ from: "/a", to: "/b" }] },
    { oldSchema: {}, samples: [{}], mappings: [{ from: "/a", to: "/b" }] },
  ]) {
    assert.throws(() => migrateSamples(args), (err) => err.status === 400);
  }
  assert.throws(
    () => migrateSamples({ oldSchema: {}, newSchema: {}, samples: "x" }),
    (err) => err.status === 400 && /samples' array/.test(err.message)
  );
  assert.throws(
    () => migrateSamples({ oldSchema: {}, newSchema: {}, samples: [{}], mappings: [] }),
    (err) => err.status === 400 && /mappings' array/.test(err.message)
  );
  assert.throws(
    () =>
      migrateSamples({
        oldSchema: {},
        newSchema: {},
        samples: [{}],
        mappings: [{ from: 1, to: "/b" }],
      }),
    (err) => err.status === 400 && /'from' and 'to'/.test(err.message)
  );
});

test(`migrateSamples enforces the ${MAX_SAMPLES} sample and ${MAX_MAPPINGS} mapping caps`, () => {
  assert.throws(
    () =>
      migrateSamples({
        oldSchema: {},
        newSchema: {},
        samples: Array.from({ length: MAX_SAMPLES + 1 }, () => ({})),
        mappings: [{ from: "/a", to: "/b" }],
      }),
    (err) => err.status === 400 && new RegExp(MAX_SAMPLES).test(err.message)
  );
  assert.throws(
    () =>
      migrateSamples({
        oldSchema: {},
        newSchema: {},
        samples: [{}],
        mappings: Array.from({ length: MAX_MAPPINGS + 1 }, (_, i) => ({
          from: `/a${i}`,
          to: `/b${i}`,
        })),
      }),
    (err) => err.status === 400 && new RegExp(MAX_MAPPINGS).test(err.message)
  );
});

test("migrateSamples accepts an empty sample set", () => {
  const result = run([], [{ from: "/a", to: "/b" }]);
  assert.equal(result.total, 0);
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.successfulSamples, []);
  assert.deepEqual(result.summary, {
    migrated: 0,
    conflict: 0,
    noop: 0,
    valid: 0,
    invalid: 0,
  });
});

test("migrateSamples rejects an uncompilable schema with 422", () => {
  assert.throws(
    () =>
      migrateSamples({
        oldSchema: { type: "nope" },
        newSchema: {},
        samples: [{}],
        mappings: [{ from: "/a", to: "/b" }],
      }),
    (err) => err.status === 422 && /Invalid schema/.test(err.message)
  );
});

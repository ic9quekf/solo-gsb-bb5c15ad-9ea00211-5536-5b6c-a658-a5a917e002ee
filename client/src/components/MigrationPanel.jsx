import { useEffect, useMemo, useState } from "react";
import { migrateSamples } from "../api.js";
import { SideResult } from "./CounterexamplePanel.jsx";

// Keep in sync with MAX_SAMPLES / MAX_MAPPINGS in server/migrate.js.
const MAX_SAMPLES = 200;
const MAX_MAPPINGS = 20;

const GROUP_ORDER = ["invalid", "conflict", "noop", "migrated"];

const GROUP_META = {
  migrated: {
    label: "成功（通过当前 Schema）",
    hint: "迁移后用 Ajv 校验当前 Schema 通过",
    chip: "mg-count--ok",
  },
  invalid: {
    label: "校验失败",
    hint: "迁移完成但未通过当前 Schema，展开可查看 Ajv 错误",
    chip: "mg-count--invalid",
  },
  conflict: {
    label: "冲突",
    hint: "目标已存在值或结构不兼容，样本保持原样",
    chip: "mg-count--err",
  },
  noop: {
    label: "无变化",
    hint: "所有映射均未命中（源缺失且未补值，或目标已有值）",
    chip: "mg-count--muted",
  },
};

const OP_STATUS_META = {
  applied: { label: "已执行", cls: "mg-op--applied" },
  skipped: { label: "保留原值", cls: "mg-op--skipped" },
  noop: { label: "未命中", cls: "mg-op--noop" },
  conflict: { label: "冲突", cls: "mg-op--conflict" },
  blocked: { label: "未执行", cls: "mg-op--blocked" },
};

const OP_KIND_LABEL = { move: "移动", fill: "补值", keep: "保留", noop: "跳过" };

/**
 * Historical sample migration, shown on the "契约演进" tab. Reuses the
 * session baseline and the currently inferred schema: old samples are
 * pasted as a JSON array, a list of "source JSON Pointer -> target JSON
 * Pointer" mappings (with optional defaults) is planned by the backend
 * and applied atomically per sample. The result is summarized into
 * migrated / conflict / no-op, with migrated documents split into those
 * passing the current Ajv validation and those failing it. Every row
 * expands into a before/after diff plus an operation trace; a single
 * button copies exactly the successful documents.
 */
export default function MigrationPanel({ baselineSchema, currentSchema }) {
  const [text, setText] = useState("");
  const [mappings, setMappings] = useState([{ from: "", to: "", defaultValue: "" }]);
  const [parseError, setParseError] = useState(null);
  const [error, setError] = useState(null);
  const [mappingErrors, setMappingErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [openIndex, setOpenIndex] = useState(null);
  const [copied, setCopied] = useState(false);

  // A new baseline or a re-inferred schema invalidates the previous run.
  useEffect(() => {
    setResult(null);
    setError(null);
    setMappingErrors(null);
    setOpenIndex(null);
  }, [baselineSchema, currentSchema]);

  const trimmed = useMemo(
    () =>
      mappings.map((m) => ({
        from: m.from.trim(),
        to: m.to.trim(),
        defaultValue: m.defaultValue,
      })),
    [mappings]
  );
  // A mapping needs both pointers (root is typed as the single "/").
  const hasBlankPointer = trimmed.some((m) => m.from === "" || m.to === "");

  const groups = useMemo(() => {
    if (!result) return [];
    const buckets = new Map(GROUP_ORDER.map((g) => [g, []]));
    for (const item of result.samples) {
      const key = item.status === "migrated" ? (item.current.valid ? "migrated" : "invalid") : item.status;
      buckets.get(key).push(item);
    }
    return GROUP_ORDER.map((key) => [key, buckets.get(key)]);
  }, [result]);

  function updateMapping(index, field, value) {
    setMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)));
  }

  function addMapping() {
    setMappings((prev) => [...prev, { from: "", to: "", defaultValue: "" }]);
  }

  function removeMapping(index) {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  }

  function normalizePointer(value) {
    // Allow users to type "/" for the root; canonical root is "".
    return value === "/" ? "" : value;
  }

  async function run() {
    setError(null);
    setMappingErrors(null);
    setResult(null);
    setOpenIndex(null);
    setCopied(false);

    let samples;
    try {
      samples = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    if (!Array.isArray(samples)) {
      setError('输入必须是 JSON 数组：每个元素为一条旧样本，例如 [{"id": 1}, {"id": 2}]。');
      return;
    }
    if (samples.length === 0) {
      setError("样本数组不能为空，请至少粘贴一条旧样本。");
      return;
    }
    if (samples.length > MAX_SAMPLES) {
      setError(`单次最多迁移 ${MAX_SAMPLES} 条样本，当前输入共 ${samples.length} 条，请分批迁移。`);
      return;
    }
    if (trimmed.some((m) => m.from === "" || m.to === "")) {
      setError("每条映射都需要填写源 JSON Pointer 与目标 JSON Pointer（根节点请填 “/”）。");
      return;
    }

    const payloadMappings = [];
    for (const m of trimmed) {
      const mapping = { from: normalizePointer(m.from), to: normalizePointer(m.to) };
      if (m.defaultValue.trim() !== "") {
        try {
          mapping.default = JSON.parse(m.defaultValue);
        } catch (e) {
          setError(`默认值必须是合法 JSON（字符串需带引号，如 "unknown"、true、null、0）：${e.message}`);
          return;
        }
      }
      payloadMappings.push(mapping);
    }

    setBusy(true);
    try {
      const data = await migrateSamples(baselineSchema, currentSchema, samples, payloadMappings);
      setResult(data);
    } catch (e) {
      setError(e.message);
      // 422 planner refusals carry per-mapping details.
      setMappingErrors(e.data && Array.isArray(e.data.mappingErrors) ? e.data.mappingErrors : null);
    } finally {
      setBusy(false);
    }
  }

  async function copySuccessful() {
    if (!result || result.successfulSamples.length === 0) return;
    const text = JSON.stringify(result.successfulSamples, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const successCount = result ? result.successfulSamples.length : 0;

  return (
    <div className="migration">
      <div className="scan-head">
        <span className="panel-label">历史样本迁移</span>
        <span className="panel__meta">
          粘贴旧样本 JSON 数组，按「源 JSON Pointer → 目标 JSON Pointer」配置映射（可选默认值）；
          后端先按路径深度规划再逐条原子执行，数组元素、父子重叠与目标冲突均会处理（单次最多{" "}
          {MAX_SAMPLES} 条样本、{MAX_MAPPINGS} 条映射）
        </span>
      </div>

      <textarea
        className={`code-input ${parseError ? "code-input--err" : ""}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={5}
        placeholder='[{"id": 1, "phone": null}, {"id": 2, "phone": "+86-13800000000"}]'
      />
      {parseError && <div className="parse-error">JSON 解析失败：{parseError}</div>}

      <div className="mg-mapping-head">
        <span>源 JSON Pointer</span>
        <span>目标 JSON Pointer</span>
        <span>默认值（可选，JSON）</span>
        <span />
      </div>
      <div className="mg-mappings">
        {mappings.map((mapping, i) => {
          const mappingError = mappingErrors?.find((e) => e.index === i);
          return (
            <div
              key={i}
              className={`mg-mapping ${mappingError ? "mg-mapping--err" : ""}`}
            >
              <input
                className="mg-mapping__input"
                value={mapping.from}
                onChange={(e) => updateMapping(i, "from", e.target.value)}
                placeholder="/phone（根用 /）"
                spellCheck={false}
              />
              <span className="mg-mapping__arrow">→</span>
              <input
                className="mg-mapping__input"
                value={mapping.to}
                onChange={(e) => updateMapping(i, "to", e.target.value)}
                placeholder="/mobile（可用 - 追加数组）"
                spellCheck={false}
              />
              <input
                className="mg-mapping__default"
                value={mapping.defaultValue}
                onChange={(e) => updateMapping(i, "defaultValue", e.target.value)}
                placeholder='如 "unknown" 或 true'
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => removeMapping(i)}
                disabled={mappings.length === 1}
                title={mappings.length === 1 ? "至少保留一条映射" : "删除该映射"}
              >
                删除
              </button>
              {mappingError && <div className="mg-mapping__error">{mappingError.reason}</div>}
            </div>
          );
        })}
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={addMapping}
          disabled={mappings.length >= MAX_MAPPINGS}
          title={mappings.length >= MAX_MAPPINGS ? `最多 ${MAX_MAPPINGS} 条映射` : ""}
        >
          + 添加映射
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={run}
          disabled={busy || text.trim() === "" || hasBlankPointer}
        >
          {busy ? "迁移中…" : "开始迁移"}
        </button>
        {result && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={copySuccessful}
            disabled={successCount === 0}
            title={successCount === 0 ? "没有可复制的成功样本" : `复制 ${successCount} 条成功结果`}
          >
            {copied ? "✓ 已复制" : `复制仅成功结果（${successCount}）`}
          </button>
        )}
      </div>

      {error && <div className="alert alert--err">{error}</div>}
      {mappingErrors && mappingErrors.length > 0 && (
        <div className="panel__meta panel__meta--block">
          共 {mappingErrors.length} 条映射配置有误，未执行任何迁移；请按上述标注修正后重试。
        </div>
      )}

      {result && (
        <>
          <div className="scan-summary">
            <span className={`scan-count mg-count mg-count--ok`}>
              成功 {result.summary.migrated - countInvalid(result)}
            </span>
            <span className="scan-count mg-count mg-count--invalid">
              校验失败 {countInvalid(result)}
            </span>
            <span className="scan-count mg-count mg-count--err">
              冲突 {result.summary.conflict}
            </span>
            <span className="scan-count mg-count mg-count--muted">
              无变化 {result.summary.noop}
            </span>
            <span className="panel__meta">共 {result.total} 条 · 点击单条展开前后对比</span>
          </div>

          {result.total === 0 && <div className="empty-hint">样本集为空，没有可迁移的内容。</div>}

          {groups.map(([key, items]) =>
            items.length === 0 ? null : (
              <div key={key} className="scan-group">
                <div className="scan-group__head">
                  <span className={`scan-count mg-count ${GROUP_META[key].chip}`}>
                    {GROUP_META[key].label} {items.length}
                  </span>
                  <span className="panel__meta">{GROUP_META[key].hint}</span>
                </div>
                <ul className="scan-list">
                  {items.map((item) => (
                    <MigrationRow
                      key={item.index}
                      item={item}
                      open={openIndex === item.index}
                      onToggle={() =>
                        setOpenIndex((prev) => (prev === item.index ? null : item.index))
                      }
                    />
                  ))}
                </ul>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

function countInvalid(result) {
  return result.samples.filter((s) => s.status === "migrated" && !s.current.valid).length;
}

function MigrationRow({ item, open, onToggle }) {
  const isInvalid = item.status === "migrated" && !item.current.valid;
  const badgeClass =
    item.status === "conflict"
      ? "ce-badge--err"
      : item.status === "noop"
        ? "ce-badge--muted"
        : isInvalid
          ? "ce-badge--invalid"
          : "ce-badge--ok";
  const label =
    item.status === "conflict"
      ? "冲突"
      : item.status === "noop"
        ? "无变化"
        : isInvalid
          ? "校验失败"
          : "成功";

  return (
    <li className="scan-item">
      <button type="button" className="scan-item__head" onClick={onToggle} aria-expanded={open}>
        <span className="scan-item__index">#{item.index}</span>
        <span className={`ce-badge ${badgeClass}`}>{label}</span>
        <span
          className={`ce-badge ${item.baseline.valid ? "ce-badge--ok" : "ce-badge--err"}`}
          title="迁移前按基线 Schema 校验"
        >
          基线 {item.baseline.valid ? "✓" : "✗"}
        </span>
        <span
          className={`ce-badge ${item.current.valid ? "ce-badge--ok" : "ce-badge--err"}`}
          title="迁移后按当前 Schema 校验"
        >
          当前 {item.current.valid ? "✓" : "✗"}
        </span>
        <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="scan-item__detail">
          {item.reason && <div className="alert alert--err mg-reason">{item.reason}</div>}
          <ul className="mg-ops">
            {item.operations.map((op) => {
              const meta = OP_STATUS_META[op.status];
              return (
                <li key={op.index} className={`mg-op ${meta.cls}`}>
                  <span className="mg-op__kind">{OP_KIND_LABEL[op.kind] || op.kind}</span>
                  <code className="mg-op__pointer">{op.from === "" ? "(root)" : op.from}</code>
                  <span className="mg-op__arrow">→</span>
                  <code className="mg-op__pointer">{op.to === "" ? "(root)" : op.to}</code>
                  {op.hasDefault && <span className="mg-op__default">含默认值</span>}
                  <span className="mg-op__status">{meta.label}</span>
                  {op.detail && <span className="mg-op__detail">{op.detail}</span>}
                </li>
              );
            })}
          </ul>
          <div className="mg-diff">
            <div className="mg-diff__side">
              <div className="mg-diff__title">迁移前</div>
              <pre className="mg-diff__code">{JSON.stringify(item.before, null, 2)}</pre>
            </div>
            <div className="mg-diff__side">
              <div className="mg-diff__title">
                迁移后{item.status !== "migrated" && "（保持原样）"}
              </div>
              <pre className="mg-diff__code">
                {JSON.stringify(item.status === "migrated" ? item.after : item.before, null, 2)}
              </pre>
            </div>
          </div>
          <SideResult label="基线 Schema（迁移前）" result={item.baseline} />
          <SideResult label="当前 Schema（迁移后）" result={item.current} />
        </div>
      )}
    </li>
  );
}

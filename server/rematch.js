'use strict';

const { normalizeText } = require('./normalizer');

// 压缩为可比较的文本：规范化（全角转半角、中文数字转阿拉伯数字）后去除所有空白。
// 摘录可能跨分段（含换行），分段正文也可能由续行合并（含 \n），统一去空白后做包含匹配。
function compact(s) {
  return normalizeText(s == null ? '' : String(s)).replace(/\s+/g, '');
}

// 前端在无真实时间戳时会生成「片段 N」兜底标签，不能当作时间戳参与匹配
function isRealLabel(label) {
  return !!label && !/^片段\s*\d+$/.test(String(label).trim());
}

// 时间戳维度评分：2=一致（双方都有真实标签），1=中性（至少一方无标签），0=冲突。
// 注意：时间戳是「定位」信息——修订原文时改时间戳属正常情况，仅用于多命中时的排序消歧，
// 不会因单一命中的时间戳不同而阻止自动迁移（新标签会覆盖旧标签）。
function tsScore(evLabel, segLabel) {
  const a = isRealLabel(evLabel) ? String(evLabel).trim() : '';
  const b = isRealLabel(segLabel) ? String(segLabel).trim() : '';
  if (!a || !b) return 1;
  return a === b ? 2 : 0;
}

// 说话人维度评分：2=一致（双方都非空），1=中性（至少一方缺失），0=冲突。
// 说话人是「身份」信息：文字唯一命中但说话人被改到另一人时不静默迁移，转人工确认。
function spScore(evSpeaker, segSpeaker) {
  const a = String(evSpeaker || '').trim();
  const b = String(segSpeaker || '').trim();
  if (!a || !b) return 1;
  return a === b ? 2 : 0;
}

// 按窗口长度 1 → 2 → 3 逐级寻找包含摘录正文的分段窗口，
// 短窗口命中即返回，避免重叠窗口造成虚假的“多匹配”
function locateWindows(needle, segments) {
  if (!needle) return [];
  for (let len = 1; len <= 3; len++) {
    const hits = [];
    for (let i = 0; i + len <= segments.length; i++) {
      const text = segments.slice(i, i + len).map((s) => s.text).join('\n');
      if (compact(text).includes(needle)) {
        hits.push({ ord: segments[i].ord, len });
      }
    }
    if (hits.length) return hits;
  }
  return [];
}

function displayLabel(seg) {
  return seg.time_label || `片段 ${seg.ord + 1}`;
}

// 对已有证据逐条给出修订后的定位决策：
//   { id, state:'located', ord }                 唯一匹配，更新定位
//   { id, state:'pending', info:{reason,...} }   无匹配 / 多匹配 / 定位信息冲突
// 已被用户保留为历史快照的证据冻结，不再参与重匹配。
function rematchEvidence(evidences, segments) {
  const byOrd = new Map(segments.map((s, i) => [s.ord, { seg: s, index: i }]));
  const decisions = [];

  for (const ev of evidences) {
    if (ev.match_state === 'snapshot') {
      decisions.push({ id: ev.id, state: 'snapshot' });
      continue;
    }

    const needle = compact(ev.excerpt);
    const windows = locateWindows(needle, segments);

    if (!windows.length) {
      decisions.push({
        id: ev.id, state: 'pending',
        info: { reason: 'no_match', candidates: [], at: new Date().toISOString() }
      });
      continue;
    }

    const scored = windows.map((w) => {
      const { seg } = byOrd.get(w.ord);
      return { ...w, ts: tsScore(ev.time_label, seg.time_label), sp: spScore(ev.speaker, seg.speaker) };
    });
    // 说话人优先消歧（身份不可静默替换），时间戳仅用于同说话人下的次序消歧
    const maxSp = Math.max(...scored.map((s) => s.sp));
    const spBest = scored.filter((s) => s.sp === maxSp);
    const maxTs = Math.max(...spBest.map((s) => s.ts));
    const best = spBest.filter((s) => s.ts === maxTs);

    // 唯一文字命中（或经说话人/时间戳消歧后唯一）且说话人不冲突 → 自动更新定位
    if (best.length === 1 && maxSp !== 0) {
      decisions.push({ id: ev.id, state: 'located', ord: best[0].ord });
      continue;
    }

    const reason = maxSp === 0 ? 'conflict' : 'multi_match';
    decisions.push({
      id: ev.id,
      state: 'pending',
      info: {
        reason,
        candidates: best.map((b) => ({ ord: b.ord, len: b.len })),
        all: scored.map((b) => ({ ord: b.ord, len: b.len, ts: b.ts, sp: b.sp })),
        at: new Date().toISOString()
      }
    });
  }

  return decisions;
}

module.exports = { rematchEvidence, displayLabel };

'use strict';

/*
 * 原文修订影响追踪：保存编辑后的采访原文后，将已有证据摘录与新分段重新匹配。
 *
 * 匹配依据（文本 + 时间戳 + 说话人）：
 *   1. 文本：去除全部空白后，摘录必须是某个分段（或若干连续分段拼接）的子串；
 *   2. 时间戳：摘录保存时携带的真实时间戳（HH:MM:SS）与候选分段一致；
 *   3. 说话人：摘录保存时的说话人与候选分段一致。
 *
 * 判定规则（绝不静默丢失或错误迁移）：
 *   - 唯一候选（或多个文本候选中仅一个同时满足全部可用锚点）→ 更新定位（matched）；
 *   - 找不到候选 → 待确认（pending / missing）；
 *   - 多个候选无法区分 → 待确认（pending / ambiguous），保留候选列表供人工重绑；
 *   - 用户显式「保留为历史快照」的证据不再参与后续重匹配（snapshot）。
 */

const db = require('./db');

// 去除全部空白（含换行），用于“摘录 ⊆ 分段文本”判定
function compactText(s) {
  return String(s || '').replace(/\s+/g, '');
}

// 旧证据对无时间戳分段使用「片段 N」作为展示标签；它不是真实时间戳锚点
function canonicalLabel(label) {
  const l = String(label || '').trim();
  if (!l || /^片段\s*\d+$/.test(l)) return '';
  return l;
}

// 证据引用标签：有真实时间戳时用时间戳，否则返回空串（前端按 seg_ord 显示「片段 N」）
function citeLabelOf(seg) {
  return seg && seg.time_label ? seg.time_label : '';
}

function preview(seg) {
  const t = String(seg.text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

/*
 * 在分段列表中寻找摘录的全部文本候选位置。
 * 对每个起点 i，向后扩展直到拼接文本首次包含摘录（最短跨度），
 * 因此摘录完全落在某一段内时只会产生单段候选，不会产生多余的跨段候选。
 * 多段跨度额外要求首尾两段都真正承载摘录内容（去掉首段或末段后就不再包含），
 * 否则该跨度会把摘录“错嫁”到前面的无关分段上，造成静默错误迁移。
 * 返回 [{ start, end, time_label, speaker }]，按起点去重。
 */
function findCandidates(ev, segments) {
  const needle = compactText(ev.excerpt);
  if (!needle) return [];

  const compactSegs = segments.map((s) => compactText(s.text));
  const found = new Map(); // key: start-end -> candidate
  const MAX_SPAN = 12;

  for (let i = 0; i < segments.length; i++) {
    let joined = '';
    for (let j = i; j < segments.length && j < i + MAX_SPAN; j++) {
      joined += compactSegs[j];
      if (joined.length < needle.length) continue;
      if (joined.includes(needle)) {
        let valid = true;
        if (j > i) {
          const withoutFirst = compactSegs.slice(i + 1, j + 1).join('');
          const withoutLast = compactSegs.slice(i, j).join('');
          if (withoutFirst.includes(needle) || withoutLast.includes(needle)) valid = false;
        }
        if (valid) {
          const key = `${i}-${j}`;
          if (!found.has(key)) {
            found.set(key, {
              start: i,
              end: j,
              time_label: segments[i].time_label || '',
              speaker: segments[i].speaker || ''
            });
          }
        }
        break; // 从 i 出发的最短跨度，不再继续向后扩展
      }
    }
  }
  return [...found.values()];
}

// 候选与摘录锚点的吻合度：说话人、时间戳各 2 分（仅当摘录携带该锚点时计分）
function anchorScore(cand, ev) {
  let score = 0;
  const evSpeaker = String(ev.speaker || '').trim();
  const evTime = canonicalLabel(ev.time_label);
  if (evSpeaker && cand.speaker === evSpeaker) score += 2;
  if (evTime && cand.time_label === evTime) score += 2;
  return score;
}

// 锚点是否全部吻合（用于在多个文本候选中筛出强候选）
function anchorsAllMatch(cand, ev) {
  const evSpeaker = String(ev.speaker || '').trim();
  const evTime = canonicalLabel(ev.time_label);
  if (evSpeaker && cand.speaker !== evSpeaker) return false;
  if (evTime && cand.time_label !== evTime) return false;
  return true;
}

function candidatePayload(cand, segments) {
  const seg = segments[cand.start];
  return {
    seg_ord: seg.ord,
    start: cand.start,
    end: cand.end,
    time_label: cand.time_label,
    speaker: cand.speaker,
    text_preview: preview(seg)
  };
}

/*
 * 重匹配某条证据，返回 { status, reason, candidate }：
 *   status='matched' 时 candidate 为唯一定位；
 *   status='pending' 时 reason 为 'missing' | 'ambiguous'。
 */
function matchEvidence(ev, segments) {
  const candidates = findCandidates(ev, segments);
  if (candidates.length === 0) return { status: 'pending', reason: 'missing', candidates: [] };
  if (candidates.length === 1) return { status: 'matched', reason: '', candidates, candidate: candidates[0] };

  const strong = candidates.filter((c) => anchorsAllMatch(c, ev));
  if (strong.length === 1) return { status: 'matched', reason: '', candidates, candidate: strong[0] };

  // 无锚点或锚点全部缺失时，按得分取唯一最高分；平分则待确认
  const scored = candidates
    .map((c) => ({ c, score: anchorScore(c, ev) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && scored[0].score > scored[1].score) {
    return { status: 'matched', reason: '', candidates, candidate: scored[0].c };
  }
  return { status: 'pending', reason: 'ambiguous', candidates };
}

const updEvidence = db.prepare(`
  UPDATE evidence
  SET seg_ord = ?, match_status = ?, pending_reason = ?, match_candidates = ?,
      time_label = ?, speaker = ?
  WHERE id = ?
`);

function applyMatched(ev, cand, segments) {
  const seg = segments[cand.start];
  updEvidence.run(
    seg.ord, 'matched', '', '[]',
    citeLabelOf(seg),
    seg.speaker || ev.speaker || '',
    ev.id
  );
}

function applyPending(evId, reason, cands, segments) {
  const payload = JSON.stringify(cands.map((c) => candidatePayload(c, segments)));
  // 待确认时保留原有的时间戳/说话人/定位（旧定位可能已失效，seg_ord 置空以免错误跳转）
  db.prepare(`
    UPDATE evidence
    SET seg_ord = NULL, match_status = 'pending', pending_reason = ?, match_candidates = ?
    WHERE id = ?
  `).run(reason, payload, evId);
}

/*
 * 重新匹配采访下全部非历史快照证据。在替换分段后的同一事务中调用。
 * 返回 { total, updated, pending }
 */
function rematchInterview(interviewId) {
  const segments = db.prepare('SELECT * FROM segments WHERE interview_id = ? ORDER BY ord').all(interviewId);
  const evidences = db.prepare(`
    SELECT e.* FROM evidence e
    JOIN claims c ON c.id = e.claim_id
    WHERE c.interview_id = ? AND e.match_status != 'snapshot'
    ORDER BY e.id
  `).all(interviewId);

  let updated = 0;
  let pending = 0;
  for (const ev of evidences) {
    const r = matchEvidence(ev, segments);
    if (r.status === 'matched') {
      applyMatched(ev, r.candidate, segments);
      updated++;
    } else {
      applyPending(ev.id, r.reason, r.candidates, segments);
      pending++;
    }
  }
  return { total: evidences.length, updated, pending };
}

/*
 * 新建证据时的定位：优先用前端回传的 seg_ord；
 * 缺失时按文本做一次最佳努力匹配（不产生待确认，匹配不到也不阻塞创建）。
 * 返回 { seg_ord, time_label, speaker }
 */
function locateNewEvidence(ev, segments, segOrd) {
  if (Number.isInteger(segOrd) && segments.some((s) => s.ord === segOrd)) {
    const seg = segments.find((s) => s.ord === segOrd);
    return { seg_ord: seg.ord, time_label: citeLabelOf(seg), speaker: seg.speaker || ev.speaker || '' };
  }
  const candidates = findCandidates(ev, segments);
  if (candidates.length === 1) {
    const seg = segments[candidates[0].start];
    return { seg_ord: seg.ord, time_label: citeLabelOf(seg), speaker: seg.speaker || ev.speaker || '' };
  }
  if (candidates.length > 1) {
    const strong = candidates.filter((c) => anchorsAllMatch(c, ev));
    if (strong.length === 1) {
      const seg = segments[strong[0].start];
      return { seg_ord: seg.ord, time_label: citeLabelOf(seg), speaker: seg.speaker || ev.speaker || '' };
    }
  }
  return { seg_ord: null, time_label: canonicalLabel(ev.time_label), speaker: ev.speaker || '' };
}

/*
 * 用户处理一条待确认证据：
 *   action='rebind'    → 绑定到指定新片段（segOrd），恢复 matched；
 *   action='snapshot'  → 保留为历史快照，不再参与重匹配，seg_ord 置空。
 */
function resolveEvidence(evidenceId, action, segOrd) {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId);
  if (!ev) {
    const e = new Error('证据不存在');
    e.status = 404;
    throw e;
  }
  const claim = db.prepare('SELECT interview_id FROM claims WHERE id = ?').get(ev.claim_id);
  if (!claim) {
    const e = new Error('主张不存在');
    e.status = 404;
    throw e;
  }

  if (action === 'snapshot') {
    db.prepare(`
      UPDATE evidence
      SET match_status = 'snapshot', pending_reason = '', match_candidates = '[]', seg_ord = NULL
      WHERE id = ?
    `).run(evidenceId);
    return { interviewId: claim.interview_id, action };
  }

  if (action === 'rebind') {
    const ord = parseInt(segOrd, 10);
    if (!Number.isInteger(ord)) {
      const e = new Error('请选择要重新绑定的片段');
      e.status = 400;
      throw e;
    }
    const seg = db.prepare('SELECT * FROM segments WHERE interview_id = ? AND ord = ?')
      .get(claim.interview_id, ord);
    if (!seg) {
      const e = new Error('目标片段不存在');
      e.status = 400;
      throw e;
    }
    db.prepare(`
      UPDATE evidence
      SET match_status = 'matched', pending_reason = '', match_candidates = '[]',
          seg_ord = ?, time_label = ?, speaker = ?
      WHERE id = ?
    `).run(seg.ord, citeLabelOf(seg), seg.speaker || ev.speaker, evidenceId);
    return { interviewId: claim.interview_id, action };
  }

  const e = new Error('非法处理操作');
  e.status = 400;
  throw e;
}

// 采访下待确认证据数
function pendingCount(interviewId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM evidence e
    JOIN claims c ON c.id = e.claim_id
    WHERE c.interview_id = ? AND e.match_status = 'pending'
  `).get(interviewId);
  return row.n;
}

module.exports = {
  rematchInterview,
  resolveEvidence,
  locateNewEvidence,
  pendingCount,
  canonicalLabel
};

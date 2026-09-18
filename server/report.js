'use strict';

const STATUS_LABELS = {
  unverified: '待核实',
  verified: '已证实',
  refuted: '已证伪',
  disputed: '有争议',
  corrected: '已更正'
};

const TYPE_LABELS = { numeric: '数值冲突', negation: '肯定/否定冲突' };

const PENDING_REASON_LABELS = {
  no_match: '新原文中未找到对应文字',
  multi_match: '在多个新分段中命中，无法唯一确定',
  conflict: '文字命中但说话人不一致，为避免错误迁移需人工确认'
};

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
}

function factText(f) {
  if (f.cat === 'date') {
    if (f.unit === 'full') return `日期：${f.raw}`;
    if (f.unit === 'year') return `年份：${f.raw}`;
    if (f.unit === 'ym') return `月份：${f.raw}`;
    return `月份：${f.raw}`;
  }
  const labels = {
    money: '金额', percent: '比例', age: '年龄', duration: '时长',
    area: '面积', distance: '距离', weight: '重量', count: '数量'
  };
  return `${labels[f.cat] || f.cat}：${f.raw}`;
}

function buildReport(iv) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const lines = [];
  lines.push(`# 采访事实核查报告：${mdEscape(iv.title)}`);
  lines.push('');
  lines.push(`- 来源 / 被访人：${iv.source ? mdEscape(iv.source) : '（未填写）'}`);
  lines.push(`- 报告生成时间：${stamp}`);
  lines.push(`- 事实主张数：${iv.claims.length}`);
  const activeContra = iv.contradictions.filter((c) => !c.ignored);
  lines.push(`- 未解决的矛盾提示：${activeContra.length}`);
  const pendingTotal = iv.claims.reduce(
    (n, c) => n + c.evidence.filter((e) => (e.match_state || 'located') === 'pending').length, 0
  );
  const snapshotTotal = iv.claims.reduce(
    (n, c) => n + c.evidence.filter((e) => e.match_state === 'snapshot').length, 0
  );
  lines.push(`- 原文修订版本：第 ${iv.revision || 0} 次修订`);
  if (pendingTotal) lines.push(`- ⚠️ 待确认定位的证据：${pendingTotal} 条（见各主张明细，导出前请在工作台处理）`);
  if (snapshotTotal) lines.push(`- 历史快照证据：${snapshotTotal} 条（修订前原文记录，不再对应当前原文）`);
  lines.push('');

  /* ---------- 一、矛盾清单 ---------- */
  lines.push('## 一、互相矛盾的说法');
  lines.push('');
  if (!activeContra.length) {
    lines.push('未检测到互相矛盾的主张。');
  } else {
    activeContra.forEach((c, idx) => {
      const types = c.types.split(',').filter(Boolean).map((t) => TYPE_LABELS[t] || t).join('、');
      lines.push(`### ${idx + 1}. ${types}`);
      c.detail.split('\n').forEach((d) => lines.push(`- ${d}`));
      if (c.claim_a) lines.push(`- 主张 #${c.claim_a.id}（${STATUS_LABELS[c.claim_a.status]}）：${mdEscape(c.claim_a.normalized_text)}`);
      if (c.claim_b) lines.push(`- 主张 #${c.claim_b.id}（${STATUS_LABELS[c.claim_b.status]}）：${mdEscape(c.claim_b.normalized_text)}`);
      lines.push('');
    });
  }
  lines.push('');

  /* ---------- 二、主张核查明细 ---------- */
  lines.push('## 二、事实主张核查明细');
  lines.push('');
  if (!iv.claims.length) {
    lines.push('（暂无主张）');
  }
  iv.claims.forEach((c, idx) => {
    lines.push(`### 主张 #${c.id} — ${STATUS_LABELS[c.status] || c.status}`);
    lines.push('');
    lines.push(`**规范化表述：** ${mdEscape(c.normalized_text)}`);
    lines.push('');
    if (c.facts.length) {
      lines.push(`**抽取的关键事实：** ${c.facts.map(factText).join('；')}`);
      lines.push('');
    }
    if (c.note && c.note.trim()) {
      lines.push(`**审核备注：** ${mdEscape(c.note)}`);
      lines.push('');
    }
    const formatEv = (ev) => {
      const cite = ev.time_label ? `[${ev.time_label}]` : '[无时间戳]';
      const speaker = ev.speaker ? ` **${mdEscape(ev.speaker)}：**` : '';
      return `${cite}${speaker} ${mdEscape(ev.excerpt)}`;
    };
    const located = c.evidence.filter((e) => (e.match_state || 'located') === 'located');
    const pending = c.evidence.filter((e) => e.match_state === 'pending');
    const snapshots = c.evidence.filter((e) => e.match_state === 'snapshot');

    if (!c.evidence.length) {
      lines.push('**证据链：** （暂无关联证据）');
    } else {
      lines.push('**当前定位证据：**');
      lines.push('');
      if (located.length) {
        located.forEach((ev, i) => lines.push(`${i + 1}. ${formatEv(ev)}`));
      } else {
        lines.push('（暂无；原有证据待确认或已归入历史快照）');
      }
      lines.push('');

      if (pending.length) {
        lines.push('**⚠️ 待确认定位（修订原文后无法自动匹配，需人工处理）：**');
        lines.push('');
        pending.forEach((ev, i) => {
          const reason = ev.match_info && PENDING_REASON_LABELS[ev.match_info.reason]
            ? PENDING_REASON_LABELS[ev.match_info.reason] : '定位待确认';
          lines.push(`${i + 1}. ${formatEv(ev)} — *${reason}*`);
        });
        lines.push('');
      }

      if (snapshots.length) {
        lines.push('**历史快照（修订前原文中的证据，不再对应当前原文）：**');
        lines.push('');
        snapshots.forEach((ev, i) => lines.push(`${i + 1}. ${formatEv(ev)}`));
        lines.push('');
      }
    }
    lines.push('');
  });

  /* ---------- 三、原文时间轴 ---------- */
  lines.push('## 三、附录：采访原文时间轴');
  lines.push('');
  iv.segments.forEach((s) => {
    const label = s.time_label || `片段 ${s.ord + 1}`;
    const speaker = s.speaker ? `${s.speaker}：` : '';
    lines.push(`- \`[${label}]\` ${speaker}${mdEscape(s.text).replace(/\n/g, ' ')}`);
  });
  lines.push('');
  lines.push('---');
  lines.push('*本报告由采访事实核查工作台生成；矛盾提示为规则引擎自动检测结果，最终结论以人工审核为准。*');

  return lines.join('\n');
}

module.exports = { buildReport };

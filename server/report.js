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
  missing: '原文修订后未找到对应片段',
  ambiguous: '原文修订后存在多个可能片段'
};

function evidenceStatusOf(ev) {
  return ev.match_status === 'snapshot' ? 'snapshot'
    : ev.match_status === 'pending' ? 'pending' : 'current';
}

// 引用标签：优先真实时间戳；无时间戳时按 seg_ord 显示「片段 N」（待确认/快照仅作历史说明）
function citeLabel(ev) {
  if (ev.time_label) return ev.time_label;
  if (Number.isInteger(ev.seg_ord)) return `片段 ${ev.seg_ord + 1}`;
  return '无时间戳';
}

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
  const pendingTotal = iv.claims.reduce((n, c) =>
    n + c.evidence.filter((e) => e.match_status === 'pending').length, 0);
  const snapshotTotal = iv.claims.reduce((n, c) =>
    n + c.evidence.filter((e) => e.match_status === 'snapshot').length, 0);
  if (pendingTotal) {
    lines.push(`- ⚠️ 待确认的证据定位：${pendingTotal} 条（原文修订后未能唯一定位，尚未完成人工处理）`);
  }
  if (snapshotTotal) {
    lines.push(`- 历史快照证据：${snapshotTotal} 条（保留修订前内容，不指向当前原文）`);
  }
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
    if (c.evidence.length) {
      const current = c.evidence.filter((e) => evidenceStatusOf(e) === 'current');
      const pending = c.evidence.filter((e) => evidenceStatusOf(e) === 'pending');
      const snapshots = c.evidence.filter((e) => evidenceStatusOf(e) === 'snapshot');

      const renderEv = (ev, i) => {
        const speaker = ev.speaker ? ` **${mdEscape(ev.speaker)}：**` : '';
        return `${i + 1}. [${citeLabel(ev)}]${speaker} ${mdEscape(ev.excerpt)}`;
      };

      lines.push(`**证据链（当前定位 ${current.length} 条${pending.length ? `，待确认 ${pending.length} 条` : ''}${snapshots.length ? `，历史快照 ${snapshots.length} 条` : ''}）：**`);
      lines.push('');

      if (current.length) {
        current.forEach((ev, i) => lines.push(renderEv(ev, i)));
      } else if (!pending.length && !snapshots.length) {
        lines.push('（暂无关联证据）');
      }

      pending.forEach((ev) => {
        const reason = PENDING_REASON_LABELS[ev.pending_reason] || '原文修订后定位待确认';
        const speaker = ev.speaker ? ` **${mdEscape(ev.speaker)}：**` : '';
        lines.push(`- ⚠️ **待确认**（${reason}；原定位 [${citeLabel(ev)}]）${speaker} ${mdEscape(ev.excerpt)}`);
      });

      snapshots.forEach((ev) => {
        const speaker = ev.speaker ? ` **${mdEscape(ev.speaker)}：**` : '';
        lines.push(`- 🗄️ **历史快照**（修订前定位 [${citeLabel(ev)}]，不指向当前原文）${speaker} ${mdEscape(ev.excerpt)}`);
      });
    } else {
      lines.push('**证据链：** （暂无关联证据）');
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

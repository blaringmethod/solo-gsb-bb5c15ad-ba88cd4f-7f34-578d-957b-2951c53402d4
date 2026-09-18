'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const { parseTranscript } = require('./parser');
const { normalizeClaim, detectRelations } = require('./normalizer');
const { rematchEvidence, displayLabel } = require('./rematch');
const { buildReport } = require('./report');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------------- helpers ---------------- */

function rowToClaim(r) {
  return { ...r, keywords: JSON.parse(r.keywords || '[]'), facts: JSON.parse(r.facts || '[]') };
}

function rowToEvidence(r) {
  return { ...r, match_info: r.match_info ? JSON.parse(r.match_info) : null };
}

function getInterviewOrThrow(id) {
  const iv = db.prepare('SELECT * FROM interviews WHERE id = ?').get(id);
  if (!iv) {
    const e = new Error('采访不存在');
    e.status = 404;
    throw e;
  }
  return iv;
}

function loadInterview(id) {
  const iv = getInterviewOrThrow(id);
  iv.segments = db.prepare('SELECT * FROM segments WHERE interview_id = ? ORDER BY ord').all(id);
  iv.claims = db.prepare('SELECT * FROM claims WHERE interview_id = ? ORDER BY id').all(id).map(rowToClaim);
  for (const c of iv.claims) {
    c.evidence = db.prepare('SELECT * FROM evidence WHERE claim_id = ? ORDER BY id').all(c.id).map(rowToEvidence);
  }
  iv.pending_count = db.prepare(
    "SELECT COUNT(*) AS n FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE c.interview_id = ? AND e.match_state = 'pending'"
  ).get(id).n;
  const contra = db.prepare('SELECT * FROM contradictions WHERE interview_id = ? ORDER BY id').all(id);
  const claimById = new Map(iv.claims.map((c) => [c.id, c]));
  iv.contradictions = contra.map((r) => ({
    ...r,
    ignored: !!r.ignored,
    claim_a: claimById.get(r.claim_a_id) || null,
    claim_b: claimById.get(r.claim_b_id) || null
  }));
  return iv;
}

function replaceSegments(interviewId, segments) {
  const del = db.prepare('DELETE FROM segments WHERE interview_id = ?');
  const ins = db.prepare(
    'INSERT INTO segments (interview_id, ord, time_label, seconds, speaker, text) VALUES (?, ?, ?, ?, ?, ?)'
  );
  del.run(interviewId);
  const tx = db.transaction((segs) => {
    segs.forEach((s) => ins.run(interviewId, s.ord, s.time_label, s.seconds, s.speaker, s.text));
  });
  tx(segments);
}

// 重新解析全文：替换分段，并把已有证据按 文本/时间戳/说话人 重新匹配。
// 唯一匹配 → 自动更新定位；无匹配 / 多匹配 / 定位信息冲突 → 标记 pending 待确认；
// 历史快照（snapshot）冻结，不参与重匹配。证据不会被静默删除或错误迁移。
function reparse(interviewId, transcript) {
  const segments = parseTranscript(transcript);
  replaceSegments(interviewId, segments);

  const evidences = db.prepare(`
    SELECT e.* FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE c.interview_id = ?
  `).all(interviewId);
  if (!evidences.length) return { pending: 0 };

  // 原文被清空（无任何分段）：所有非快照证据都无法定位
  const decisions = segments.length
    ? rematchEvidence(evidences, segments)
    : evidences
        .filter((e) => e.match_state !== 'snapshot')
        .map((e) => ({ id: e.id, state: 'pending', info: { reason: 'no_match', candidates: [], at: new Date().toISOString() } }))
    .concat(evidences.filter((e) => e.match_state === 'snapshot').map((e) => ({ id: e.id, state: 'snapshot' })));

  const updLocated = db.prepare(
    "UPDATE evidence SET match_state = 'located', match_info = '', time_label = ?, speaker = ? WHERE id = ?"
  );
  const updPending = db.prepare(
    "UPDATE evidence SET match_state = 'pending', match_info = ? WHERE id = ?"
  );
  const tx = db.transaction(() => {
    for (const d of decisions) {
      if (d.state === 'located') {
        const seg = segments.find((s) => s.ord === d.ord);
        updLocated.run(displayLabel(seg), seg.speaker || '', d.id);
      } else if (d.state === 'pending') {
        updPending.run(JSON.stringify(d.info), d.id);
      }
      // snapshot：保持不变
    }
  });
  tx();
  return { pending: decisions.filter((d) => d.state === 'pending').length };
}

function recomputeContradictions(interviewId) {
  const claims = db.prepare('SELECT * FROM claims WHERE interview_id = ? ORDER BY id').all(interviewId).map(rowToClaim);
  const old = db.prepare('SELECT claim_a_id, claim_b_id, ignored FROM contradictions WHERE interview_id = ?').all(interviewId);
  const ignoredMap = new Map(old.map((r) => [`${r.claim_a_id}-${r.claim_b_id}`, r.ignored]));

  const rels = detectRelations(claims);

  db.prepare('DELETE FROM contradictions WHERE interview_id = ?').run(interviewId);
  const ins = db.prepare(
    'INSERT INTO contradictions (interview_id, claim_a_id, claim_b_id, types, detail, ignored) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const r of rels) {
      if (r.kind !== 'contradiction') continue;
      const key = `${r.aId}-${r.bId}`;
      const ignored = ignoredMap.has(key) ? ignoredMap.get(key) : 0;
      ins.run(interviewId, r.aId, r.bId, r.types.join(','), r.detail.join('\n'), ignored);
    }
  });
  tx();

  // 重复提示不入库，直接返回给调用方
  return rels.filter((r) => r.kind === 'duplicate');
}

/* ---------------- interview routes ---------------- */

app.get('/api/interviews', (req, res) => {
  const rows = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM claims c WHERE c.interview_id = i.id) AS claim_count,
      (SELECT COUNT(*) FROM contradictions x WHERE x.interview_id = i.id AND x.ignored = 0) AS contradiction_count,
      (SELECT COUNT(*) FROM evidence e JOIN claims c2 ON c2.id = e.claim_id
        WHERE c2.interview_id = i.id AND e.match_state = 'pending') AS pending_count
    FROM interviews i ORDER BY i.updated_at DESC, i.id DESC
  `).all();
  res.json(rows);
});

app.post('/api/interviews', (req, res) => {
  const title = (req.body.title || '未命名采访').toString().slice(0, 200);
  const source = (req.body.source || '').toString().slice(0, 500);
  const transcript = (req.body.transcript || '').toString();
  const info = db.transaction(() => {
    const r = db.prepare('INSERT INTO interviews (title, source, transcript) VALUES (?, ?, ?)').run(title, source, transcript);
    reparse(r.lastInsertRowid, transcript);
    return r.lastInsertRowid;
  })();
  res.json(loadInterview(info));
});

app.get('/api/interviews/:id', (req, res) => {
  res.json(loadInterview(parseInt(req.params.id, 10)));
});

app.put('/api/interviews/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const iv = getInterviewOrThrow(id);
  const title = (req.body.title || '未命名采访').toString().slice(0, 200);
  const source = (req.body.source || '').toString().slice(0, 500);
  const transcript = (req.body.transcript || '').toString();
  const transcriptChanged = transcript !== (iv.transcript || '');
  let pending = 0;
  db.transaction(() => {
    if (transcriptChanged) {
      db.prepare(
        "UPDATE interviews SET title = ?, source = ?, transcript = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ?"
      ).run(title, source, transcript, id);
      // 仅在原文实际修改时重新分段并对证据重匹配，避免仅改标题就扰动已人工确认的定位
      pending = reparse(id, transcript).pending;
      recomputeContradictions(id);
    } else {
      db.prepare("UPDATE interviews SET title = ?, source = ?, updated_at = datetime('now') WHERE id = ?")
        .run(title, source, id);
    }
  })();
  const fresh = loadInterview(id);
  fresh.pending_delta = pending;
  res.json(fresh);
});

app.delete('/api/interviews/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM interviews WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/interviews/:id/segments', (req, res) => {
  const id = parseInt(req.params.id, 10);
  getInterviewOrThrow(id);
  res.json(db.prepare('SELECT * FROM segments WHERE interview_id = ? ORDER BY ord').all(id));
});

/* ---------------- claim routes ---------------- */

app.post('/api/interviews/:id/claims', (req, res) => {
  const interviewId = parseInt(req.params.id, 10);
  getInterviewOrThrow(interviewId);
  const original = (req.body.original_text || '').toString();
  const rawText = (req.body.text || original || '').toString().trim();
  if (!rawText) return res.status(400).json({ error: '主张内容不能为空' });

  const n = normalizeClaim(rawText);
  const r = db.prepare(`
    INSERT INTO claims (interview_id, normalized_text, original_text, keywords, facts, polarity, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    interviewId, n.normalizedText, original, JSON.stringify(n.keywords),
    JSON.stringify(n.facts), n.polarity, 'unverified', ''
  );
  const claimId = r.lastInsertRowid;

  // 创建主张时附带的证据摘录
  const evs = Array.isArray(req.body.evidence) ? req.body.evidence : [];
  const insEv = db.prepare('INSERT INTO evidence (claim_id, excerpt, time_label, speaker) VALUES (?, ?, ?, ?)');
  evs.forEach((e) => {
    const excerpt = String(e.excerpt || '').trim();
    if (!excerpt) return;
    insEv.run(claimId, excerpt.slice(0, 2000), String(e.time_label || '').slice(0, 20), String(e.speaker || '').slice(0, 80));
  });

  const duplicates = recomputeContradictions(interviewId);
  res.json({ interview: loadInterview(interviewId), claimId, duplicates });
});

app.put('/api/claims/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) return res.status(404).json({ error: '主张不存在' });

  const fields = [];
  const values = [];

  if (req.body.text !== undefined) {
    const n = normalizeClaim(String(req.body.text));
    fields.push('normalized_text = ?', 'keywords = ?', 'facts = ?', 'polarity = ?');
    values.push(n.normalizedText, JSON.stringify(n.keywords), JSON.stringify(n.facts), n.polarity);
  }
  if (req.body.status !== undefined) {
    const allowed = ['unverified', 'verified', 'refuted', 'disputed', 'corrected'];
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: '非法状态' });
    fields.push('status = ?');
    values.push(req.body.status);
  }
  if (req.body.note !== undefined) {
    fields.push('note = ?');
    values.push(String(req.body.note).slice(0, 2000));
  }
  if (!fields.length) return res.status(400).json({ error: '没有可更新字段' });

  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE claims SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  recomputeContradictions(claim.interview_id);
  res.json(loadInterview(claim.interview_id));
});

app.delete('/api/claims/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) return res.status(404).json({ error: '主张不存在' });
  db.prepare('DELETE FROM claims WHERE id = ?').run(id);
  recomputeContradictions(claim.interview_id);
  res.json(loadInterview(claim.interview_id));
});

/* ---------------- evidence routes ---------------- */

app.post('/api/claims/:id/evidence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) return res.status(404).json({ error: '主张不存在' });
  const excerpt = String(req.body.excerpt || '').trim();
  if (!excerpt) return res.status(400).json({ error: '证据摘录不能为空' });
  db.prepare('INSERT INTO evidence (claim_id, excerpt, time_label, speaker) VALUES (?, ?, ?, ?)')
    .run(id, excerpt.slice(0, 2000), String(req.body.time_label || '').slice(0, 20), String(req.body.speaker || '').slice(0, 80));
  res.json(loadInterview(claim.interview_id));
});

app.delete('/api/evidence/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ error: '证据不存在' });
  const claim = db.prepare('SELECT interview_id FROM claims WHERE id = ?').get(ev.claim_id);
  db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
  res.json(loadInterview(claim.interview_id));
});

// 修订待确认队列处理：把证据重新绑定到指定新片段，或保留为历史快照
app.post('/api/evidence/:id/resolve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ error: '证据不存在' });
  const claim = db.prepare('SELECT interview_id FROM claims WHERE id = ?').get(ev.claim_id);

  const action = String(req.body.action || '');
  if (action === 'snapshot') {
    db.prepare("UPDATE evidence SET match_state = 'snapshot', match_info = ? WHERE id = ?").run(
      JSON.stringify({ resolved_at: new Date().toISOString(), note: String(req.body.note || '').slice(0, 500) }), id
    );
    return res.json(loadInterview(claim.interview_id));
  }

  if (action !== 'rebind') return res.status(400).json({ error: 'action 必须为 rebind 或 snapshot' });

  const ord = parseInt(req.body.segment_ord, 10);
  if (Number.isNaN(ord)) return res.status(400).json({ error: '缺少目标分段 segment_ord' });
  const seg = db.prepare('SELECT * FROM segments WHERE interview_id = ? AND ord = ?').get(claim.interview_id, ord);
  if (!seg) return res.status(400).json({ error: '目标分段不存在' });

  db.prepare(
    "UPDATE evidence SET match_state = 'located', match_info = '', time_label = ?, speaker = ? WHERE id = ?"
  ).run(displayLabel(seg), seg.speaker || '', id);
  res.json(loadInterview(claim.interview_id));
});

/* ---------------- contradiction routes ---------------- */

app.put('/api/contradictions/:id/ignore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT * FROM contradictions WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: '矛盾记录不存在' });
  const ignored = req.body.ignored ? 1 : 0;
  db.prepare('UPDATE contradictions SET ignored = ? WHERE id = ?').run(ignored, id);
  res.json(loadInterview(c.interview_id));
});

/* ---------------- report ---------------- */

app.get('/api/interviews/:id/report', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const iv = loadInterview(id);
  const md = buildReport(iv);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="factcheck-report-${id}.md"`);
  res.send(md);
});

/* ---------------- error handler ---------------- */

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`采访事实核查工作台已启动: http://localhost:${PORT}`);
});

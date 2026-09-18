'use strict';

/* ================= 全局状态 ================= */
const state = {
  interviews: [],
  current: null,
  selection: null,
  showIgnored: false
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ================= API ================= */
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

/* ================= 小工具 ================= */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function openModal(id) { $('#' + id).hidden = false; }
function closeModal(node) {
  const mask = node.closest('.modal-mask');
  if (mask) mask.hidden = true;
}
document.addEventListener('click', (e) => {
  if (e.target.matches('.modal-mask')) e.target.hidden = true;
  const btn = e.target.closest('[data-close]');
  if (btn) closeModal(btn);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-mask').forEach((m) => { m.hidden = true; });
});

const STATUS_LABELS = {
  unverified: '待核实', verified: '已证实', refuted: '已证伪',
  disputed: '有争议', corrected: '已更正'
};
const TYPE_LABELS = { numeric: '数值冲突', negation: '肯定/否定冲突', duplicate: '疑似重复' };

/* ================= 采访列表 ================= */
async function loadList(selectId) {
  state.interviews = await api('GET', '/api/interviews');
  const list = $('#interviewList');
  list.innerHTML = '';
  if (!state.interviews.length) {
    list.appendChild(el('div', { class: 'iv-item', style: 'color:var(--muted);cursor:default', text: '还没有采访记录' }));
  }
  for (const iv of state.interviews) {
    const meta = el('div', { class: 'm' }, [
      el('span', { text: `主张 ${iv.claim_count}` }),
      iv.contradiction_count > 0
        ? el('span', { class: 'badge-conflict', text: `⚠ ${iv.contradiction_count}` })
        : null
    ]);
    list.appendChild(el('div', {
      class: 'iv-item' + (state.current && state.current.id === iv.id ? ' active' : ''),
      onclick: () => openInterview(iv.id)
    }, [el('div', { class: 't', text: iv.title }), meta]));
  }
  if (selectId) openInterview(selectId);
}

async function openInterview(id) {
  state.current = await api('GET', `/api/interviews/${id}`);
  $('#emptyState').hidden = true;
  $('#workspace').hidden = false;
  $('#topActions').hidden = false;
  renderAll();
  loadList();
}

function renderAll() {
  const iv = state.current;
  $('#ivTitle').textContent = iv.title;
  $('#ivSource').textContent = iv.source ? `来源/被访人：${iv.source}` : '';
  renderSegments();
  renderConflicts();
  renderClaims();
}

/* ================= 时间轴原文 ================= */
function renderSegments() {
  const box = $('#segments');
  box.innerHTML = '';
  state.current.segments.forEach((seg) => {
    const label = seg.time_label || `片段 ${seg.ord + 1}`;
    const body = el('div', { class: 'seg-body' });
    if (seg.speaker) body.appendChild(el('span', { class: 'seg-speaker', text: seg.speaker + '：' }));
    body.appendChild(el('span', { class: 'seg-text', text: seg.text }));

    const time = el('div', {
      class: 'seg-time',
      title: '点击定位',
      text: `[${label}]`,
      onclick: () => flashElement(row)
    });
    time.dataset.segOrd = seg.ord;
    time.dataset.timeLabel = seg.time_label || '';
    time.dataset.speaker = seg.speaker || '';

    const row = el('div', { class: 'seg', 'data-seg-ord': seg.ord }, [time, body]);
    box.appendChild(row);
  });
}

function flashElement(node) {
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.animate(
    [{ background: '#c6d2f7' }, { background: 'transparent' }],
    { duration: 1400 }
  );
}

/* ================= 划选工具条 ================= */
function getSelectionInfo() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startText = range.startContainer.parentElement ? range.startContainer.parentElement.closest('.seg-text') : null;
  const endText = range.endContainer.parentElement ? range.endContainer.parentElement.closest('.seg-text') : null;
  if (!startText || !endText || !document.body.contains(startText)) return null;

  const startSeg = startText.closest('.seg');
  const endSeg = endText.closest('.seg');
  if (!startSeg || !endSeg) return null;

  const sOrd = parseInt(startSeg.dataset.segOrd, 10);
  const eOrd = parseInt(endSeg.dataset.segOrd, 10);
  if (sOrd > eOrd) return null;

  const segs = state.current.segments;
  let text = '';
  for (let i = sOrd; i <= eOrd; i++) {
    const seg = segs[i];
    let piece = seg.text;
    if (i === sOrd) {
      const r = range.cloneRange();
      r.setEnd(startText, startText.childNodes.length);
      piece = r.toString();
    }
    if (i === eOrd && sOrd !== eOrd) {
      const r = range.cloneRange();
      r.setStart(endText, 0);
      piece = r.toString();
    }
    if (sOrd === eOrd) piece = range.toString();
    text += (text ? '\n' : '') + piece;
  }
  text = text.trim();
  if (!text) return null;

  const meta = startSeg.querySelector('.seg-time').dataset;
  return {
    text,
    timeLabel: meta.timeLabel || `片段 ${sOrd + 1}`,
    speaker: meta.speaker || '',
    segOrd: sOrd
  };
}

document.addEventListener('selectionchange', () => {
  if (!state.current) return;
  const toolbar = $('#selToolbar');
  setTimeout(() => {
    const info = getSelectionInfo();
    if (!info) { toolbar.hidden = true; return; }
    state.selection = info;
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) { toolbar.hidden = true; return; }
    toolbar.hidden = false;
    const top = Math.max(rect.top - 42, 8) + window.scrollY;
    const left = Math.min(rect.left, window.innerWidth - 250);
    toolbar.style.top = `${top}px`;
    toolbar.style.left = `${Math.max(8, left)}px`;
  }, 10);
});

// 工具条按下时先阻止选区丢失
$('#selToolbar').addEventListener('mousedown', (e) => e.preventDefault());

$('#selToClaim').addEventListener('click', () => {
  if (!state.selection) return;
  $('#selToolbar').hidden = true;
  const info = state.selection;
  $('#claimText').value = info.text.replace(/\n/g, ' ');
  renderEvidencePreview([{ excerpt: info.text, time_label: info.timeLabel, speaker: info.speaker }]);
  openModal('claimModal');
  setTimeout(() => $('#claimText').focus(), 50);
  window.getSelection().removeAllRanges();
});

$('#selToEvidence').addEventListener('click', async () => {
  if (!state.selection) return;
  $('#selToolbar').hidden = true;
  const info = state.selection;
  $('#evidenceQuote').textContent = `[${info.timeLabel}]${info.speaker ? ' ' + info.speaker + '：' : ''}${info.text}`;
  const select = $('#evidenceTarget');
  select.innerHTML = '';
  const claims = state.current.claims;
  if (!claims.length) {
    toast('还没有事实主张，请先建立一条主张', 'warn');
    window.getSelection().removeAllRanges();
    return;
  }
  claims.forEach((c) => {
    select.appendChild(el('option', { value: c.id, text: `#${c.id} ${c.normalized_text.slice(0, 40)}` }));
  });
  openModal('evidenceModal');
  window.getSelection().removeAllRanges();
});

/* ================= 主张卡片 ================= */
function factChipHTML(f) {
  const who = f.subject ? `${esc(f.subject)}·` : '';
  let val = f.raw;
  if (f.cat === 'date') {
    if (f.unit === 'full') val = `日期 ${f.raw}`;
    else if (f.unit === 'year') val = `${f.raw}`;
    else val = f.raw;
  }
  return `<span class="fact-chip">${who}<b>${esc(val)}</b></span>`;
}

function renderEvidencePreview(evs) {
  const box = $('#claimEvidencePreview');
  box.innerHTML = '';
  $('#claimEvidenceHint').textContent = evs.length ? '' : '（暂无，保存后可在原文划选追加）';
  evs.forEach((e) => {
    box.appendChild(el('div', { class: 'ev-item' }, [
      el('span', { class: 'ev-cite', text: `[${e.time_label || '—'}]` }),
      e.speaker ? el('span', { class: 'ev-speaker', text: e.speaker + '：' }) : null,
      document.createTextNode(e.excerpt)
    ]));
  });
}

function conflictClaimIds() {
  const set = new Set();
  state.current.contradictions
    .filter((c) => !c.ignored)
    .forEach((c) => { set.add(c.claim_a_id); set.add(c.claim_b_id); });
  return set;
}

function renderClaims() {
  const box = $('#claims');
  box.innerHTML = '';
  const filter = $('#statusFilter').value;
  const claims = state.current.claims.filter((c) => filter === 'all' || c.status === filter);
  $('#claimCount').textContent = state.current.claims.length;

  if (!claims.length) {
    box.appendChild(el('div', {
      style: 'color:var(--muted);text-align:center;padding:30px 10px;line-height:1.8',
      text: state.current.claims.length ? '当前状态筛选下没有主张' : '在左侧原文中划选文字，即可建立第一条事实主张'
    }));
    return;
  }

  const badIds = conflictClaimIds();

  claims.forEach((c) => {
    const card = el('div', {
      class: 'claim-card' + (badIds.has(c.id) ? ' has-conflict' : ''),
      id: 'claim-' + c.id
    });

    // 顶部：编号 + 状态
    const statusSelect = el('select', {
      'aria-label': '审核状态',
      onchange: (e) => updateClaim(c.id, { status: e.target.value })
    }, Object.entries(STATUS_LABELS).map(([v, label]) =>
      el('option', { value: v, ...(c.status === v ? { selected: 'selected' } : {}), text: label })
    ));
    const top = el('div', { class: 'claim-top' }, [
      el('span', { class: 'claim-id', text: `主张 #${c.id}` }),
      el('span', { class: `status-pill status-${c.status}`, text: STATUS_LABELS[c.status] || c.status }),
      el('span', { class: 'spacer' }),
      statusSelect
    ]);
    card.appendChild(top);

    // 正文
    card.appendChild(el('div', { class: 'claim-text', text: c.normalized_text }));

    // 提取的数值事实
    if (c.facts.length) {
      const chips = el('div', { class: 'claim-facts' });
      c.facts.forEach((f) => { chips.insertAdjacentHTML('beforeend', factChipHTML(f)); });
      card.appendChild(chips);
    }

    // 证据链
    card.appendChild(el('div', { class: 'claim-section-label', text: `证据链（${c.evidence.length}）` }));
    c.evidence.forEach((ev) => {
      const item = el('div', { class: 'ev-item' }, [
        el('span', {
          class: 'ev-cite',
          text: `[${ev.time_label || '—'}]`,
          title: '跳转到原文位置',
          onclick: () => jumpToSegment(ev.time_label)
        }),
        ev.speaker ? el('span', { class: 'ev-speaker', text: ev.speaker + '：' }) : null,
        document.createTextNode(ev.excerpt),
        el('span', { class: 'ev-del', text: '✕', title: '删除证据', onclick: () => removeEvidence(ev.id) })
      ]);
      card.appendChild(item);
    });

    // 审核备注
    const note = el('textarea', {
      class: 'claim-note',
      rows: 1,
      placeholder: '审核备注：核实过程、信息来源、判定理由…',
      onblur: (e) => { if (e.target.value !== c.note) updateClaim(c.id, { note: e.target.value }); }
    });
    note.value = c.note;
    card.appendChild(note);

    card.appendChild(el('div', { class: 'claim-actions' }, [
      el('button', { class: 'link-btn', text: '删除主张', onclick: () => removeClaim(c.id) })
    ]));

    box.appendChild(card);
  });
}

function jumpToSegment(timeLabel) {
  if (!timeLabel) return;
  let t = [...$$('.seg-time')].find((n) => n.dataset.timeLabel === timeLabel);
  // 无真实时间戳时的兜底标签：「片段 N」对应第 N 段（从 1 开始）
  if (!t) {
    const m = timeLabel.match(/^片段\s*(\d+)$/);
    if (m) t = $(`.seg-time[data-seg-ord="${parseInt(m[1], 10) - 1}"]`);
  }
  if (t) flashElement(t.closest('.seg'));
  else toast('原文中未找到该时间戳（可能原文已更新）', 'warn');
}

/* ================= 矛盾提示 ================= */
function renderConflicts() {
  const banner = $('#conflictBanner');
  const list = $('#conflictList');
  list.innerHTML = '';
  const items = state.current.contradictions.filter((c) => state.showIgnored || !c.ignored);
  banner.hidden = items.length === 0;
  if (!items.length) return;

  items.forEach((c) => {
    const tags = c.types.split(',').filter(Boolean).map((t) =>
      el('span', { class: `tag ${t}`, text: TYPE_LABELS[t] || t })
    );
    const item = el('div', { class: 'conflict-item' + (c.ignored ? ' ignored' : '') }, [
      el('div', { class: 'conflict-tags' }, tags),
      el('div', { class: 'conflict-detail' }, c.detail.split('\n').map((d, i) =>
        el('div', { text: (i + 1) + '. ' + d })
      )),
      el('div', { class: 'conflict-pair' }, [
        miniClaim(c.claim_a_id),
        miniClaim(c.claim_b_id)
      ]),
      el('div', { class: 'conflict-actions' }, [
        el('button', {
          class: 'link-btn',
          text: c.ignored ? '恢复提示' : '忽略（误报）',
          onclick: () => toggleIgnore(c.id, !c.ignored)
        })
      ])
    ]);
    list.appendChild(item);
  });
}

function miniClaim(id) {
  const c = state.current.claims.find((x) => x.id === id);
  if (!c) return el('span', { class: 'mini-claim', text: `#${id}（已删除）` });
  return el('span', {
    class: 'mini-claim',
    text: `#${c.id} ${c.normalized_text.slice(0, 60)}${c.normalized_text.length > 60 ? '…' : ''}`,
    title: '跳转到主张',
    onclick: () => {
      const node = $('#claim-' + id);
      if (node) {
        if ($('#statusFilter').value !== 'all') $('#statusFilter').value = 'all';
        renderClaims();
        flashElement($('#claim-' + id));
      }
    }
  });
}

/* ================= 数据操作 ================= */
async function updateClaim(id, patch) {
  try {
    state.current = await api('PUT', `/api/claims/${id}`, patch);
    renderConflicts();
    renderClaims();
    loadList();
  } catch (e) { toast(e.message, 'error'); }
}

async function removeClaim(id) {
  if (!confirm(`确定删除主张 #${id} 及其全部证据？`)) return;
  try {
    state.current = await api('DELETE', `/api/claims/${id}`);
    renderConflicts();
    renderClaims();
    loadList();
    toast('主张已删除');
  } catch (e) { toast(e.message, 'error'); }
}

async function removeEvidence(id) {
  try {
    state.current = await api('DELETE', `/api/evidence/${id}`);
    renderClaims();
    toast('证据已删除');
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleIgnore(id, ignored) {
  try {
    state.current = await api('PUT', `/api/contradictions/${id}/ignore`, { ignored });
    renderConflicts();
    renderClaims();
    loadList();
  } catch (e) { toast(e.message, 'error'); }
}

$('#statusFilter').addEventListener('change', renderClaims);
$('#chkIgnored').addEventListener('change', (e) => { state.showIgnored = e.target.checked; renderConflicts(); });

/* ================= 保存主张 ================= */
$('#btnSaveClaim').addEventListener('click', async () => {
  const text = $('#claimText').value.trim();
  if (!text) { toast('主张内容不能为空', 'warn'); return; }
  const sel = state.selection;
  const evidence = sel ? [{
    excerpt: sel.text,
    time_label: sel.timeLabel,
    speaker: sel.speaker
  }] : [];
  try {
    const result = await api('POST', `/api/interviews/${state.current.id}/claims`, {
      text,
      original_text: sel ? sel.text : '',
      evidence
    });
    state.current = result.interview;
    state.selection = null;
    $('#claimModal').hidden = true;
    renderAll();
    loadList();
    toast('主张已建立');
    (result.duplicates || []).forEach((d) => {
      const a = state.current.claims.find((c) => c.id === d.aId);
      if (a) toast(`提示：#${d.aId} 与 #${d.bId} 高度相似，可能是重复主张`, 'warn');
    });
  } catch (e) { toast(e.message, 'error'); }
});

/* ================= 追加证据 ================= */
$('#btnLinkEvidence').addEventListener('click', async () => {
  const claimId = parseInt($('#evidenceTarget').value, 10);
  const info = state.selection;
  if (!info || !claimId) return;
  try {
    state.current = await api('POST', `/api/claims/${claimId}/evidence`, {
      excerpt: info.text,
      time_label: info.timeLabel,
      speaker: info.speaker
    });
    $('#evidenceModal').hidden = true;
    state.selection = null;
    renderClaims();
    toast('证据已关联到主张 #' + claimId);
  } catch (e) { toast(e.message, 'error'); }
});

/* ================= 新建 / 编辑采访 ================= */
const SAMPLE = `[00:00:05] 记者：感谢李总接受采访。首先请介绍一下公司的基本情况？
[00:00:12] 受访者：我们公司是2018年在杭州成立的，最早是做企业内部协同工具，现在主要产品是面向制造业的供应链SaaS平台。
[00:00:35] 记者：目前团队规模大概多少人？
[00:00:40] 受访者：截至上个月，全职员工大概有320人，其中研发占比超过一半。核心创始团队一开始只有8个人。
[00:01:05] 记者：去年的经营情况方便透露吗？
[00:01:10] 受访者：2025年全年营收大约2亿元人民币，同比增长60%，毛利率维持在70%左右。
[00:01:40] 记者：融资方面呢？
[00:01:45] 受访者：我们在2022年完成了A轮融资，是红杉投的，金额是5000万元。
[00:02:20] 记者：我看到公开报道里提到一些不太一样的数字，您怎么看？
[00:02:26] 受访者：那些报道不准确。我们2023年其实没有融过资，A轮确实是2022年完成的。
[00:02:45] 记者：那营收数字呢？
[00:02:50] 受访者：2025年营收并没有2亿元，实际是1.2亿元左右，我之前对外说高了。
[00:03:15] 记者：员工人数有报道写的是450人。
[00:03:20] 受访者：450人是把外包和实习生都算进去了，口径不同，全职是320人上下。
[00:03:40] 记者：核心团队现在还是8个人吗？
[00:03:45] 受访者：核心决策团队现在有20个人，最早起步的时候只有8个人。
[00:04:05] 记者：公司成立时间确定是2018年？
[00:04:10] 受访者：对，2018年3月注册，这个工商信息可以查到。`;

$('#btnNew').addEventListener('click', () => {
  $('#newTitle').value = '';
  $('#newSource').value = '';
  $('#newTranscript').value = '';
  openModal('newModal');
  setTimeout(() => $('#newTitle').focus(), 50);
});
$('#btnEmptyNew').addEventListener('click', () => $('#btnNew').click());

$('#btnSample').addEventListener('click', () => {
  $('#newTitle').value = '示例：某科技公司创始人专访';
  $('#newSource').value = '受访者：李某（CEO）；记者：王某';
  $('#newTranscript').value = SAMPLE;
  openModal('newModal');
});
$('#btnEmptySample').addEventListener('click', () => $('#btnSample').click());

$('#btnCreateInterview').addEventListener('click', async () => {
  const title = $('#newTitle').value.trim();
  const source = $('#newSource').value.trim();
  const transcript = $('#newTranscript').value;
  if (!title && !transcript.trim()) { toast('请至少填写标题或原文', 'warn'); return; }
  try {
    const iv = await api('POST', '/api/interviews', {
      title: title || '未命名采访', source, transcript
    });
    $('#newModal').hidden = true;
    await loadList(iv.id);
    toast('采访已创建');
  } catch (e) { toast(e.message, 'error'); }
});

$('#btnEditTranscript').addEventListener('click', () => {
  $('#editTitle').value = state.current.title;
  $('#editSource').value = state.current.source || '';
  $('#editTranscript').value = state.current.transcript || '';
  openModal('transcriptModal');
});

$('#btnSaveTranscript').addEventListener('click', async () => {
  const title = $('#editTitle').value.trim() || '未命名采访';
  try {
    state.current = await api('PUT', `/api/interviews/${state.current.id}`, {
      title,
      source: $('#editSource').value.trim(),
      transcript: $('#editTranscript').value
    });
    $('#transcriptModal').hidden = true;
    renderAll();
    loadList();
    toast('已保存并重新分段、重算矛盾');
  } catch (e) { toast(e.message, 'error'); }
});

$('#btnDeleteInterview').addEventListener('click', async () => {
  if (!confirm('确定删除该采访及其全部主张、证据？此操作不可恢复。')) return;
  try {
    await api('DELETE', `/api/interviews/${state.current.id}`);
    $('#transcriptModal').hidden = true;
    state.current = null;
    $('#workspace').hidden = true;
    $('#topActions').hidden = true;
    $('#emptyState').hidden = false;
    loadList();
    toast('采访已删除');
  } catch (e) { toast(e.message, 'error'); }
});

/* ================= 报告 ================= */
$('#btnReport').addEventListener('click', async () => {
  try {
    const md = await fetch(`/api/interviews/${state.current.id}/report`).then((r) => r.text());
    $('#reportPreview').textContent = md;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = $('#btnDownloadReport');
    a.href = url;
    a.download = `factcheck-report-${state.current.id}.md`;
    openModal('reportModal');
  } catch (e) { toast(e.message, 'error'); }
});

$('#btnCopyReport').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#reportPreview').textContent);
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择复制', 'error');
  }
});

/* ================= 启动 ================= */
loadList();

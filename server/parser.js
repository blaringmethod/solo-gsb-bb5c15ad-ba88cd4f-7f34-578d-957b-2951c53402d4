'use strict';

// 支持的时间戳形式：
//   [00:01:23] / (12:34) / 00:01:23：/ 1:23： / 【2分15秒】 / 00:01:23,400（SRT）
const TS_RE = /(?:^|[\s【\[(])?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d{1,3})?(?=[\s】\])）:：]|$)/;
const CN_TS_RE = /(\d{1,3})\s*分(?:\s*(\d{1,2})\s*秒)?/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatSeconds(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// 在一行开头寻找时间戳，返回 { label, seconds, rest } 或 null
function matchTimestamp(line) {
  const s = line.trimStart();

  let m = s.match(/^[【\[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d{1,3})?[】\])]?[\s:：]*/);
  if (m) {
    let h = 0, min = parseInt(m[1], 10), sec = parseInt(m[2], 10);
    if (m[3] !== undefined) {
      h = min;
      min = sec;
      sec = parseInt(m[3], 10);
    }
    const total = h * 3600 + min * 60 + sec;
    return { label: formatSeconds(total), seconds: total, rest: s.slice(m[0].length) };
  }

  m = s.match(/^[【\[]?(\d{1,3})\s*分(?:\s*(\d{1,2})\s*秒)?[】\]]?[\s:：]*/);
  if (m) {
    const total = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    return { label: formatSeconds(total), seconds: total, rest: s.slice(m[0].length) };
  }

  return null;
}

// 提取说话人前缀：张三：…… / 记者: ……
function splitSpeaker(text) {
  const m = text.match(/^([一-龥A-Za-z0-9·\. _-]{1,20})[：:]\s*([\s\S]*)$/);
  if (m) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: '', text: text.trim() };
}

// 将粘贴的采访原文切分为带时间戳的片段
function parseTranscript(raw) {
  const segments = [];
  const lines = String(raw || '').split(/\r?\n/);
  let ord = 0;

  const pushText = (time, label, speaker, text) => {
    const t = text.trim();
    if (!t) return;
    segments.push({
      ord: ord++,
      time_label: label || '',
      seconds: time === null || time === undefined ? null : time,
      speaker: speaker || '',
      text: t
    });
  };

  let pending = null; // 尚无时间戳归属的前导文字

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const ts = matchTimestamp(line);
    if (ts) {
      if (pending) { pushText(null, '', pending.speaker, pending.text); pending = null; }
      const sp = splitSpeaker(ts.rest);
      pushText(ts.seconds, ts.label, sp.speaker, sp.text);
    } else if (segments.length) {
      // 无时间戳的续行并入上一个片段
      const last = segments[segments.length - 1];
      last.text += '\n' + line;
    } else {
      if (!pending) pending = { speaker: '', text: '' };
      const sp = splitSpeaker(line);
      if (sp.speaker && !pending.speaker) pending.speaker = sp.speaker;
      pending.text += (pending.text ? '\n' : '') + (sp.speaker ? sp.text : line);
    }
  }
  if (pending) pushText(null, '', pending.speaker, pending.text);

  // 无时间戳的纯文本：整体作为一个片段
  if (segments.length === 0 && String(raw || '').trim()) {
    pushText(null, '', '', String(raw).trim());
  }

  return segments;
}

module.exports = { parseTranscript, formatSeconds, TS_REGEX: TS_RE, CN_TS_REGEX: CN_TS_RE };

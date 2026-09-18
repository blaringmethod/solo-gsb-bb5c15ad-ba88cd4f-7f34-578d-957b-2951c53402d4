'use strict';

/* ------------------------------------------------------------------ */
/* 文本规范化：全角转半角、中文数字转阿拉伯数字                          */
/* ------------------------------------------------------------------ */

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9
};

function convertCnNumber(s) {
  let result = 0;   // 亿/万 以上的累计
  let section = 0;  // 当前万以下小节
  let number = 0;
  let hasDigit = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) { number = CN_DIGITS[ch]; hasDigit = true; }
    else if (ch === '十') { section += (number || 1) * 10; number = 0; }
    else if (ch === '百') { section += number * 100; number = 0; }
    else if (ch === '千') { section += number * 1000; number = 0; }
    else if (ch === '万') { section = (section + number) * 1e4; result += section; section = 0; number = 0; }
    else if (ch === '亿') { section = (section + number) * 1e8; result += section; section = 0; number = 0; }
  }
  return hasDigit || section ? result + section + number : null;
}

function normalizeText(input) {
  let t = String(input || '');
  // 全角 -> 半角
  t = t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
  // 含十/百/千/万/亿 的中文数量词转阿拉伯数字，如 两百三十 -> 230、两亿 -> 2亿
  t = t.replace(/[零〇一二两三四五六七八九]+[十百千万亿][零〇一二两三四五六七八九十百千万亿]*/g, (run) => {
    const v = convertCnNumber(run);
    return v === null ? run : String(v);
  });
  // 中文年份：二零二三年 -> 2023年
  t = t.replace(/[零〇一二两三四五六七八九]{2,4}(?=\s*年)/g, (run) =>
    run.split('').map((c) => (c in CN_DIGITS ? CN_DIGITS[c] : c)).join('')
  );
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/* ------------------------------------------------------------------ */
/* 关键词切分：拉丁/数字单词 + 中文二元组（过滤停用字）                  */
/* ------------------------------------------------------------------ */

const STOP_CHARS = new Set(
  ('的了在是我你他她它们这那和与及或就都很也不没对把被让向从给但而之其以于个年月日时分秒上下中里说称约大概左右多还已曾要会能可' +
   '么吗呢吧啊呀嘛哦为到过着地得所将随再又最首其次通过进行以及之之后前内外').split('')
);

function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const tokens = new Set();

  for (const m of t.matchAll(/[a-z0-9][a-z0-9.\-]*/g)) {
    if (m[0].length >= 2 || /\d/.test(m[0])) tokens.add(m[0]);
  }
  for (const run of t.matchAll(/[一-龥]+/g)) {
    const s = run[0];
    for (let i = 0; i < s.length - 1; i++) {
      if (!STOP_CHARS.has(s[i]) && !STOP_CHARS.has(s[i + 1])) {
        tokens.add(s.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

function jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ------------------------------------------------------------------ */
/* 极性：肯定 / 否定                                                    */
/* ------------------------------------------------------------------ */

const NEGATIONS = [
  '从来没有', '并没有', '并非是', '不属于', '不是', '不会', '不能', '没有',
  '并无', '并非', '从未', '从不', '否认', '毫无', '绝非', '不予'
];

function polarityOf(text) {
  return NEGATIONS.some((w) => text.includes(w)) ? -1 : 1;
}

/* ------------------------------------------------------------------ */
/* 数值事实抽取：日期、金额、百分比、年龄、时长、度量、人数…             */
/* ------------------------------------------------------------------ */

const NUM = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九])';

function numOf(g) {
  if (/^\d/.test(g)) return parseFloat(g);
  return CN_DIGITS[g] !== undefined ? CN_DIGITS[g] : NaN;
}

function multOf(g) {
  return g === '万' ? 1e4 : g === '亿' ? 1e8 : 1;
}

function measureRegex(unitAlts, multiplier) {
  return new RegExp(NUM + (multiplier ? '(?:\\s*(万|亿))?' : '') + '\\s*(' + unitAlts + ')', 'g');
}

// 按优先级排列；同一起点更长的匹配优先，重叠匹配去重
const FACT_PATTERNS = [
  // 日期
  { re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, make: (m) => ({
    cat: 'date', unit: 'full', value: parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3])
  }) },
  { re: /(\d{4})\s*年\s*(\d{1,2})\s*月份?(?!\s*\d)/g, make: (m) => ({
    cat: 'date', unit: 'ym', value: parseInt(m[1]) * 10000 + parseInt(m[2]) * 10
  }) },
  { re: /(\d{4})\s*年(?!\s*\d{1,2}\s*月|代|初|末|底)/g, make: (m) => ({
    cat: 'date', unit: 'year', value: parseInt(m[1])
  }) },
  { re: /(\d{1,2})\s*月份?(?!\s*\d{1,2}\s*[日号])/g, make: (m) => ({
    cat: 'date', unit: 'month', value: parseInt(m[1])
  }) },
  // 金额
  { re: measureRegex('人民币|块钱|元|圆|块', true), make: (m) => ({
    cat: 'money', unit: '元', value: numOf(m[1]) * multOf(m[2])
  }) },
  // 百分比
  { re: new RegExp(NUM + '\\s*(?:%|％)', 'g'), make: (m) => ({ cat: 'percent', unit: '%', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '\\s*个百分点', 'g'), make: (m) => ({ cat: 'percent', unit: '百分点', value: numOf(m[1]) }) },
  // 年龄
  { re: new RegExp(NUM + '\\s*(?:周岁|岁)', 'g'), make: (m) => ({ cat: 'age', unit: '岁', value: numOf(m[1]) }) },
  // 时长（长单位在前）
  { re: new RegExp(NUM + '(?:\\s*万)?\\s*个?小时', 'g'), make: (m) => ({ cat: 'duration', unit: '时', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '\\s*分钟', 'g'), make: (m) => ({ cat: 'duration', unit: '分', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '\\s*个月', 'g'), make: (m) => ({ cat: 'duration', unit: '月', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '\\s*个?星期', 'g'), make: (m) => ({ cat: 'duration', unit: '周', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '\\s*周', 'g'), make: (m) => ({ cat: 'duration', unit: '周', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '(?:\\s*[万亿])?\\s*[天日]', 'g'), make: (m) => ({ cat: 'duration', unit: '日', value: numOf(m[1]) }) },
  { re: new RegExp(NUM + '\\s*(万|亿)?\\s*年(?!\\s*[代初末底])', 'g'), make: (m) => ({
    cat: 'duration', unit: '年', value: numOf(m[1]) * multOf(m[2])
  }) },
  { re: new RegExp(NUM + '\\s*秒', 'g'), make: (m) => ({ cat: 'duration', unit: '秒', value: numOf(m[1]) }) },
  // 面积
  { re: measureRegex('平方公里|平方千米', true), make: (m) => ({ cat: 'area', unit: '平方公里', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('平方米|平米', true), make: (m) => ({ cat: 'area', unit: '平方米', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('公顷', true), make: (m) => ({ cat: 'area', unit: '公顷', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('亩', true), make: (m) => ({ cat: 'area', unit: '亩', value: numOf(m[1]) * multOf(m[2]) }) },
  // 距离
  { re: measureRegex('公里|千米', true), make: (m) => ({ cat: 'distance', unit: '公里', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('厘米', true), make: (m) => ({ cat: 'distance', unit: '厘米', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('毫米', true), make: (m) => ({ cat: 'distance', unit: '毫米', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('米', true), make: (m) => ({ cat: 'distance', unit: '米', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('里', true), make: (m) => ({ cat: 'distance', unit: '里', value: numOf(m[1]) * multOf(m[2]) }) },
  // 重量
  { re: measureRegex('吨', true), make: (m) => ({ cat: 'weight', unit: '吨', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('公斤|千克', true), make: (m) => ({ cat: 'weight', unit: '公斤', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('克', true), make: (m) => ({ cat: 'weight', unit: '克', value: numOf(m[1]) * multOf(m[2]) }) },
  { re: measureRegex('斤', true), make: (m) => ({ cat: 'weight', unit: '斤', value: numOf(m[1]) * multOf(m[2]) }) },
  // 计数（人/家/个/笔…统一为“个”，依靠主语与相似度配对；保留原单位用于展示）
  { re: measureRegex('位|人|名|家|个|条|项|次|笔|台|辆|件|套|倍|篇|栋|张|份|所|轮', true), make: (m) => ({
    cat: 'count', unit: '个', rawUnit: m[3], value: numOf(m[1]) * multOf(m[2])
  }) }
];

const BOUNDARY = '，。；！？、：,;!?:\n（）()【】[]「」“”‘’\"\'…—·|▶►▸• 　';

// 主语窗口中的动词性/修饰性分隔字，扫描主语时跳过这些字
const SEP_CHARS = new Set((
  '有是为达超共现只当前起始初开曾早在概约已经将会快要大概约共整整至到达大约近逾' +
  '维持占比达涨降幅增减'
).split(''));
const CN_NUM_CHARS = '零〇一二两三四五六七八九';
// 否定字：主语与数值之间夹有否定短语时（“营收并没有2亿”），穿过去取左侧主语
const NEG_CHARS = new Set('没不并无未非否认'.split(''));

// 主语提取时需要从右侧剥离的话语性/来源性词语
const SUBJ_BLOCK_WORDS = [
  '实际', '预计', '估计', '估算', '据称', '听说', '声称', '宣称', '报道', '媒体',
  '显示', '公布', '发布', '披露', '透露', '数据', '数字', '口径', '说法', '大概',
  '大约', '左右', '官方', '对外', '公开', '信息', '工商', '社保', '调查', '统计',
  '年报', '财报', '招股', '材料', '记录', '文件', '合同', '发票', '账面', '估值'
];

function pickSubjectToken(toks) {
  // 优先取中文二元组（窗口内最靠近数值的一个），避免选到数字或量词
  const han = [...toks].reverse().find((t) => /[一-龥]/.test(t));
  return han || (toks.length ? toks[toks.length - 1] : '');
}

function subjectLeft(text, start) {
  let i = start - 1;
  // 1) 连续跳过分隔字 / 数字 / 否定字（最多 8 个）
  let skipped = 0;
  while (i >= 0 && skipped <= 8 &&
         (SEP_CHARS.has(text[i]) || CN_NUM_CHARS.includes(text[i]) || NEG_CHARS.has(text[i]))) {
    if (BOUNDARY.includes(text[i])) return '';
    i--;
    skipped++;
  }
  // 2) 向左收集连续内容字，遇到标点、否定或数字即停；停用虚词/动词先收下，后续剥离
  let run = '';
  while (i >= 0 && start - i <= 14) {
    const ch = text[i];
    if (BOUNDARY.includes(ch) || NEG_CHARS.has(ch) || CN_NUM_CHARS.includes(ch)) break;
    run = ch + run;
    i--;
  }
  // 3) 从靠数值一侧逐字剥离话语性/动词性尾巴（“只有/实际上/报道口径…”）
  run = run.slice(-8);
  const stripChars = new Set([...SEP_CHARS, ...'上下里中的得']);
  for (let k = 0; k < 8; k++) {
    let w = SUBJ_BLOCK_WORDS.find((w) => run.endsWith(w));
    if (w) { run = run.slice(0, -w.length); continue; }
    if (run.length && stripChars.has(run[run.length - 1])) { run = run.slice(0, -1); continue; }
    break;
  }
  // 取最靠近数值的有效二元组。两遍扫描：
  // 先要求两字均非停用字（“公司/员工/营收”）；
  // 找不到时再放宽为仅要求贴数值一侧非停用字（“年龄/月份”这类首字为停用字的词）
  for (const strict of [true, false]) {
    for (let p = run.length - 2; p >= 0; p--) {
      if (!/[一-龥]/.test(run[p]) || !/[一-龥]/.test(run[p + 1])) continue;
      if (!STOP_CHARS.has(run[p + 1]) && (!strict || !STOP_CHARS.has(run[p]))) {
        return run.slice(p, p + 2);
      }
    }
  }
  const toks = tokenize(run);
  return pickSubjectToken(toks);
}

function subjectRight(text, end) {
  let buf = '';
  for (let i = end; i < text.length && i - end <= 8; i++) {
    const ch = text[i];
    if (BOUNDARY.includes(ch)) break;
    buf += ch;
  }
  return pickSubjectToken(tokenize(buf.slice(0, 6)));
}

function fmtValue(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
}

function canonicalText(f) {
  if (f.cat === 'date') {
    if (f.unit === 'full') {
      const y = Math.floor(f.value / 10000), m = Math.floor((f.value % 10000) / 100), d = f.value % 100;
      return `${y}年${m}月${d}日`;
    }
    if (f.unit === 'ym') return `${Math.floor(f.value / 10000)}年${Math.floor(f.value % 10000 / 10)}月`;
    if (f.unit === 'year') return `${f.value}年`;
    return `${f.value}月`;
  }
  return fmtValue(f.value) + (f.cat === 'count' ? (f.rawUnit || f.unit) : f.unit);
}

function extractFacts(text) {
  const candidates = [];
  for (const p of FACT_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const f = p.make(m);
      if (!f || Number.isNaN(f.value)) continue;
      candidates.push({ start: m.index, end: m.index + m[0].length, ...f, raw: m[0].replace(/\s+/g, '') });
    }
  }
  // 同一起点更长者优先；重叠只保留第一条
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const facts = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.start < lastEnd) continue;
    const { start, end, ...rest } = c;
    rest.subject = subjectLeft(text, start) || (rest.cat === 'date' ? subjectRight(text, end) : '');
    facts.push(rest);
    lastEnd = end;
  }
  return facts;
}

/* ------------------------------------------------------------------ */
/* 主张规范化与矛盾检测                                                  */
/* ------------------------------------------------------------------ */

function normalizeClaim(text) {
  const normalizedText = normalizeText(text);
  return {
    normalizedText,
    keywords: tokenize(normalizedText),
    facts: extractFacts(normalizedText),
    polarity: polarityOf(normalizedText)
  };
}

function sameSubject(sa, sb) {
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const a = new Set(tokenize(sa));
  for (const t of tokenize(sb)) if (a.has(t)) return true;
  return false;
}

function numbersDiffer(a, b) {
  return Math.abs(a - b) > 1e-6 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

// 日期类事实只在相同粒度之间比较（年↔年、年月↔年月、完整日期↔完整日期），
// 避免“公司2018年成立”与“公司2018年3月注册”被误判，或不同断言的年份对撞
function sameDateGranularity(fa, fb) {
  if (fa.cat !== 'date') return true;
  const rank = { full: 2, ym: 1, year: 0, month: 0 };
  return (rank[fa.unit] ?? 0) === (rank[fb.unit] ?? 0);
}

// 返回 [{ aId, bId, types:[...], detail:[...], kind:'contradiction'|'duplicate' }]
function detectRelations(claims) {
  const rels = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i], b = claims[j];
      const sim = jaccard(a.keywords, b.keywords);
      const types = [];
      const detail = [];

      // 1) 数值/日期冲突
      const numericClashes = [];
      for (const fa of a.facts) {
        for (const fb of b.facts) {
          if (fa.cat !== fb.cat || fa.unit !== fb.unit) continue;
          if (!numbersDiffer(fa.value, fb.value)) continue;
          if (!sameDateGranularity(fa, fb)) continue;
          const subjectHit = sameSubject(fa.subject, fb.subject) ||
            // 一方主语缺失时：另一方主语若在对方句子关键词中出现，视为同一事实
            (!fa.subject && fb.subject && a.keywords.includes(fb.subject)) ||
            (!fb.subject && fa.subject && b.keywords.includes(fa.subject));
          // 主语强匹配即可信；双方主语均缺失时要求较高的整体相似度
          const bothMissing = !fa.subject && !fb.subject;
          if (subjectHit || (bothMissing && sim >= 0.4)) {
            numericClashes.push({
              subject: fa.subject || fb.subject || '',
              rawA: fa.raw, rawB: fb.raw,
              canonA: canonicalText(fa), canonB: canonicalText(fb)
            });
          }
        }
      }
      if (numericClashes.length) {
        types.push('numeric');
        detail.push(...numericClashes.map((c) => {
          const who = c.subject ? `关于「${c.subject}」：` : '';
          return `${who}「${c.rawA}」(${c.canonA}) 与 「${c.rawB}」(${c.canonB}) 不一致`;
        }));
      }

      // 2) 肯定/否定冲突
      if (a.polarity !== b.polarity && sim >= 0.5) {
        types.push('negation');
        detail.push(`两条主张表述高度重合，但一条为肯定说法、另一条含否定表述`);
      }

      if (types.length) {
        rels.push({ aId: a.id, bId: b.id, types, detail, kind: 'contradiction' });
      } else if (sim >= 0.85) {
        rels.push({
          aId: a.id, bId: b.id, types: ['duplicate'],
          detail: ['两条主张高度相似，可能是重复记录'],
          kind: 'duplicate'
        });
      }
    }
  }
  return rels;
}

module.exports = {
  normalizeText,
  normalizeClaim,
  tokenize,
  jaccard,
  extractFacts,
  canonicalText,
  detectRelations
};

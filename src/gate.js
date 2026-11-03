// 写入闸门：体积 / 编码 / 凭据。三项硬检查，按成本从低到高短路。
// Chaos 已有的引文门与值支撑门承担"证据"一项，此处不重复。
const MAX_CHARS = 8000

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export function checkSize(text) {
  if (text.length > MAX_CHARS) {
    return { code: 'E_GATE_SIZE', detail: `长度 ${text.length} > ${MAX_CHARS}` }
  }
  return null
}

export function checkEncoding(text) {
  if (text.includes('\ufffd')) {
    return { code: 'E_GATE_ENCODING', detail: '含 U+FFFD 替换字符（编码损坏）' }
  }
  const ctrl = text.match(CTRL)
  if (ctrl) {
    return {
      code: 'E_GATE_ENCODING',
      detail: `含控制字符 U+${ctrl[0].codePointAt(0).toString(16)}`,
    }
  }
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  let run = 1
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1
    if (run >= 3) return { code: 'E_GATE_ENCODING', detail: '连续 3 行完全相同（结巴退化）' }
  }
  return null
}

export function checkSecret(text) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { code: 'E_GATE_SECRET', detail: '命中凭据模式' }
  }
  return null
}

/** 返回 null 表示通过，否则 { code, detail }。按成本从低到高短路。 */
export function checkGate(sourceText, quote) {
  const text = `${sourceText}\n${quote}`
  return checkSize(text) || checkEncoding(text) || checkSecret(text)
}

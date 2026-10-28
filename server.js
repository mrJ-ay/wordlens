// 정적 파일(dist) 서빙 + Gemini OCR 프록시. API 키는 환경변수 GEMINI_API_KEY 로만 읽는다.
// OCR은 2단계: ① 사진 → 원문 그대로 전사  ② 원문 텍스트 → "단어 | 뜻" 정리
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist')
const port = process.env.PORT || 3000
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' }

const transcribePrompt = `이 이미지는 영어 단어책의 한 페이지입니다.
페이지에 보이는 모든 글자를 읽는 순서대로 원문 그대로 옮겨 적으세요.
- 단이 여러 개면 왼쪽 단부터 위에서 아래로 순서대로 적습니다.
- 줄바꿈, 번호, 품사 표기, 발음기호, 예문, 한국어, 영어를 요약하거나 고치지 말고 보이는 대로 적습니다.
- 보이지 않는 내용을 추측해서 만들지 마세요. 읽을 수 없는 부분은 건너뜁니다.
- 설명이나 코드블록 없이 옮겨 적은 글자만 출력합니다.`

const extractPrompt = (raw) => `다음은 영어 단어책 한 페이지를 OCR로 옮겨 적은 원문입니다. 줄이 섞이거나 단이 뒤엉켜 있을 수 있습니다.
여기서 영어 단어(또는 숙어)와 그 한국어 뜻을 짝지어 추출하세요.

출력 규칙:
- 한 줄에 하나씩 "단어 | 뜻" 형식으로만 출력합니다.
- 뜻이 여러 개면 쉼표로 이어서 한 줄에 씁니다. 품사 표기(n., v., adj. 등)는 뜻 앞에 둡니다.
- 번호, 발음기호, 예문, 페이지 번호, 제목, 설명 문장은 제외합니다.
- 단어와 뜻의 짝이 확실하지 않으면 그 항목은 빼세요. 원문에 없는 내용을 지어내지 마세요.
- 명백한 OCR 오타(예: 알파벳 사이에 낀 기호)는 바로잡아도 됩니다.
- 다른 설명이나 코드블록 없이 결과 줄만 출력합니다.

[원문]
${raw}`

function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function gemini(key, parts) {
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  const data = await upstream.json()
  if (!upstream.ok) throw new Error(data?.error?.message || 'Gemini 요청이 실패했어요.')
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').replace(/```[a-z]*\n?/gi, '').trim()
}

async function handleOcr(req, res) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return send(res, 500, { error: '서버에 GEMINI_API_KEY가 설정되지 않았어요.' })
  try {
    const { image, mimeType = 'image/jpeg' } = JSON.parse(await readBody(req))
    if (!image) return send(res, 400, { error: '이미지가 없어요.' })
    // ① 사진 → 원문
    const raw = await gemini(key, [{ text: transcribePrompt }, { inline_data: { mime_type: mimeType, data: image } }])
    if (!raw) return send(res, 200, { text: '', raw: '' })
    // ② 원문 → 단어 | 뜻 (실패하면 원문을 그대로 돌려줘 사용자가 직접 고칠 수 있게 한다)
    let text = raw
    try { text = (await gemini(key, [{ text: extractPrompt(raw) }])) || raw } catch { /* fall back to raw */ }
    send(res, 200, { text, raw })
  } catch (error) {
    send(res, error.message === 'too large' ? 413 : 502, { error: error.message === 'too large' ? '사진이 너무 커요.' : error.message || 'OCR 처리 중 오류가 났어요.' })
  }
}

async function serveStatic(req, res) {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const file = join(root, path)
  if (!file.startsWith(root)) return send(res, 403, { error: 'forbidden' })
  try {
    const body = await readFile(file)
    const cache = path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': cache })
    res.end(body)
  } catch {
    const body = await readFile(join(root, 'index.html'))
    res.writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-cache' })
    res.end(body)
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ocr') return handleOcr(req, res)
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res)
  send(res, 405, { error: 'method not allowed' })
}).listen(port, () => console.log(`listening on ${port}`))

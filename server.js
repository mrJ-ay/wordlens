// 정적 파일(dist) 서빙 + Gemini OCR 프록시. API 키는 환경변수 GEMINI_API_KEY 로만 읽는다.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist')
const port = process.env.PORT || 3000
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' }

const prompt = `이 이미지는 영어 단어책의 한 페이지입니다.
페이지에 있는 모든 영어 단어(또는 숙어)와 한국어 뜻을 빠짐없이 추출하세요.
출력 규칙:
- 한 줄에 하나씩 "단어 | 뜻" 형식으로만 출력합니다.
- 뜻이 여러 개면 쉼표로 이어서 한 줄에 씁니다. 품사 표기(n., v., adj. 등)는 뜻 앞에 그대로 둡니다.
- 예문, 발음기호, 페이지 번호, 제목, 설명 문장은 제외합니다.
- 보이지 않는 내용을 추측해서 만들지 마세요. 읽을 수 없는 항목은 건너뜁니다.
- 다른 설명이나 코드블록 없이 결과 줄만 출력합니다.`

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

async function handleOcr(req, res) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return send(res, 500, { error: '서버에 GEMINI_API_KEY가 설정되지 않았어요.' })
  try {
    const { image, mimeType = 'image/jpeg' } = JSON.parse(await readBody(req))
    if (!image) return send(res, 400, { error: '이미지가 없어요.' })
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: image } }] }],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      }),
    })
    const data = await upstream.json()
    if (!upstream.ok) return send(res, 502, { error: data?.error?.message || 'OCR 요청이 실패했어요.' })
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').replace(/```[a-z]*\n?/gi, '').trim()
    send(res, 200, { text })
  } catch (error) {
    send(res, 500, { error: error.message === 'too large' ? '사진이 너무 커요.' : 'OCR 처리 중 오류가 났어요.' })
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

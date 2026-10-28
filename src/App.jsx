import { useEffect, useMemo, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'

const starterDeck = [
  { id: 'meticulous', term: 'meticulous', definition: '꼼꼼한, 세심한' },
  { id: 'reluctant', term: 'reluctant', definition: '꺼리는, 망설이는' },
  { id: 'abundant', term: 'abundant', definition: '풍부한, 많은' },
  { id: 'obscure', term: 'obscure', definition: '모호한, 잘 알려지지 않은' },
  { id: 'resilient', term: 'resilient', definition: '회복력 있는, 탄력 있는' },
  { id: 'concise', term: 'concise', definition: '간결한' },
]

const storageKey = 'wordlens-deck-v1'

function readDeck() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey))
    return Array.isArray(stored) && stored.length ? stored : starterDeck
  } catch {
    return starterDeck
  }
}

function normalize(value = '') {
  return value.toLowerCase().replace(/[^a-z가-힣0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function isCorrect(item, answer, direction) {
  const expected = direction === 'definition' ? item.definition : item.term
  const a = normalize(answer)
  const e = normalize(expected)
  return Boolean(a) && (e.includes(a) || a.includes(e))
}

function parseDeckText(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const deck = []
  const headword = (value) => /^[A-Za-z][A-Za-z' -]{1,32}$/.test(value) && value.split(/\s+/).length <= 3

  for (let index = 0; index < lines.length && deck.length < 1000; index += 1) {
    const line = lines[index]
    const separated = line.match(/^(.+?)\s*(?:\||\t|:|：|—|–)\s*(.+)$/)
    if (separated) {
      deck.push({ term: separated[1].trim(), definition: separated[2].trim() })
      continue
    }
    const inline = line.match(/^([A-Za-z][A-Za-z' -]{1,32})\s+((?:n\.|v\.|adj\.|adv\.|a\.|vt\.|vi\.)?\s*[가-힣].+)$/i)
    if (inline) {
      deck.push({ term: inline[1].trim(), definition: inline[2].replace(/^(n\.|v\.|adj\.|adv\.|a\.|vt\.|vi\.)\s*/i, '').trim() })
      continue
    }
    if (headword(line) && lines[index + 1] && /[가-힣]/.test(lines[index + 1])) {
      deck.push({ term: line, definition: lines[index + 1] })
      index += 1
    }
  }
  return deck.map((item, index) => ({ ...item, id: `${normalize(item.term)}-${index}` }))
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5)
}

export default function App() {
  const [deck, setDeck] = useState(readDeck)
  const [page, setPage] = useState('learn')
  const [cramMode, setCramMode] = useState(true)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(deck))
  }, [deck])

  function replaceDeck(nextDeck) {
    setDeck(nextDeck)
    setPage('learn')
    setNotice(`${nextDeck.length}개 단어와 뜻을 암기 덱으로 만들었어요.`)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setPage('learn')} aria-label="WORDLENS 홈">WORD<span>LENS</span></button>
        <nav className="nav" aria-label="주요 메뉴">
          <button className={page === 'learn' ? 'active' : ''} onClick={() => setPage('learn')}>암기 덱</button>
          <button className={page === 'test' ? 'active' : ''} onClick={() => setPage('test')}>모의시험</button>
          <button className={page === 'scan' ? 'active' : ''} onClick={() => setPage('scan')}>단어책 스캔</button>
        </nav>
        <label className="cram-toggle">
          <span>벼락 암기</span>
          <input type="checkbox" checked={cramMode} onChange={(event) => setCramMode(event.target.checked)} />
          <i />
        </label>
      </header>

      <main>
        {page === 'learn' && <LearnPage key={`${deck.length}-${deck.map((item) => item.id).join('|')}`} deck={deck} cramMode={cramMode} onTest={() => setPage('test')} />}
        {page === 'test' && <TestPage deck={deck} onReview={(wrong) => { setDeck((current) => [...wrong, ...current.filter((item) => !wrong.some((miss) => miss.id === item.id))]); setPage('learn'); setNotice('오답 단어를 덱 맨 앞에 다시 넣었어요.') }} />}
        {page === 'scan' && <ScanPage onImport={replaceDeck} />}
      </main>
      {notice && <div className="toast" onAnimationEnd={() => setNotice('')}>{notice}</div>}
    </div>
  )
}

function LearnPage({ deck, cramMode, onTest }) {
  const [queue, setQueue] = useState(deck)
  const [index, setIndex] = useState(0)
  const [stage, setStage] = useState('show')
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [missed, setMissed] = useState([])
  const [revisiting, setRevisiting] = useState(false)
  const [completed, setCompleted] = useState(false)

  const item = queue[index]
  const progress = Math.round(((index + (stage === 'show' ? 0.3 : stage === 'review' ? 0.65 : 0.9)) / Math.max(queue.length, 1)) * 100)

  function nextStage() {
    if (stage === 'show') setStage('review')
    if (stage === 'review') setStage('recall')
  }

  function check() {
    if (feedback) return
    const correct = isCorrect(item, answer, 'definition')
    setFeedback(correct ? 'correct' : 'wrong')
    if (!correct) setMissed((current) => current.some((entry) => entry.id === item.id) ? current : [...current, item])
  }

  function advance() {
    if (index + 1 < queue.length) {
      setIndex(index + 1)
      setStage(revisiting ? 'recall' : 'show')
      setAnswer('')
      setFeedback(null)
      return
    }
    if (!revisiting && missed.length) {
      setQueue(missed)
      setIndex(0)
      setStage('recall')
      setRevisiting(true)
      setAnswer('')
      setFeedback(null)
      return
    }
    setCompleted(true)
  }

  function restart() {
    setQueue(deck)
    setIndex(0)
    setStage('show')
    setAnswer('')
    setFeedback(null)
    setMissed([])
    setRevisiting(false)
    setCompleted(false)
  }

  if (!deck.length) return <EmptyDeck />
  if (completed) return <Completion missed={missed} onRestart={restart} onTest={onTest} />

  return (
    <div className="page-wrap">
      <section className="hero-strip">
        <div><p>신규 단어 암기 · {cramMode ? '짧은 간격 재등장' : '기본 학습'}</p><h1>새 단어를 보고,<br />바로 기억으로 옮기세요.</h1></div>
        <div className="deck-count"><strong>{deck.length}</strong><span>이번 암기 덱</span></div>
      </section>
      <div className="workspace-head"><div><h2>지금 외우는 덱</h2><p>{revisiting ? '놓친 항목만 다시 회상하고 있어요.' : '입력 → 뜻 가리기 → 즉시 회상'}</p></div><span>{Math.min(index + 1, queue.length)} / {queue.length}</span></div>
      <section className="learn-layout">
        <article className="memory-card">
          <div className="card-top"><span>{stage === 'show' ? '새 항목' : stage === 'review' ? '다시 보기' : revisiting ? '약점 재회상' : '뜻 가리기'}</span><b>{stage === 'recall' ? '정답 가림' : '뜻 보기'}</b></div>
          <div className="progress"><i style={{ width: `${Math.min(progress, 100)}%` }} /></div>
          {stage !== 'recall' ? (
            <>
              <div className="term">{item.term}</div>
              <div className="definition">{item.definition}</div>
              <p className="card-note">{stage === 'show' ? '단어와 핵심 뜻을 잠깐 보고 넘기세요.' : '이제 뜻을 가립니다. 다음 화면에서 기억으로 답하세요.'}</p>
              <div className="arrow-row">
                {stage === 'review' ? <button className="bare-arrow" onClick={() => setStage('show')} aria-label="이전">←</button> : <span />}
                <button className="arrow-button" onClick={nextStage} aria-label="다음">→</button>
              </div>
            </>
          ) : (
            <>
              <p className="recall-prompt"><b>{item.term}</b><br />무슨 뜻이었죠?</p>
              <input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && (feedback ? advance() : check())} placeholder="기억나는 핵심 뜻" className="answer-input" />
              {feedback && <div className={`feedback ${feedback}`}>{feedback === 'correct' ? '기억해냈어요.' : <>정답: <strong>{item.definition}</strong></>}</div>}
              <div className="arrow-row recall-actions"><span />{feedback ? <button className="arrow-button" onClick={advance} aria-label="다음">→</button> : <button className="check-button" onClick={check}>확인 →</button>}</div>
            </>
          )}
        </article>
        <aside className="deck-panel"><div className="panel-title">암기 덱 <small>{deck.length}개</small></div><div className="deck-list">{deck.map((entry) => <div className={entry.id === item.id ? 'current' : missed.some((miss) => miss.id === entry.id) ? 'missed' : ''} key={entry.id}><i />{entry.term}</div>)}</div><button className="test-link" onClick={onTest}>이 덱으로 모의시험 →</button></aside>
      </section>
    </div>
  )
}

function Completion({ missed, onRestart, onTest }) {
  return <div className="page-wrap"><section className="completion"><span>✦</span><p>암기 덱 완료</p><h1>단어를 기억에서 꺼냈습니다.</h1><div className="completion-stats"><div><b>{missed.length}</b><small>다시 볼 단어</small></div><div><b>1</b><small>완료한 덱</small></div></div><div className="completion-actions"><button className="secondary-button" onClick={onRestart}>처음부터 다시</button><button className="primary-button" onClick={onTest}>모의시험 보기 →</button></div></section></div>
}

function EmptyDeck() { return <div className="page-wrap"><section className="empty"><h1>암기 덱이 비어 있어요.</h1><p>단어책 스캔에서 단어와 뜻을 가져오면 바로 시작할 수 있습니다.</p></section></div> }

function TestPage({ deck, onReview }) {
  const [direction, setDirection] = useState('definition')
  const [phase, setPhase] = useState('setup')
  const [items, setItems] = useState([])
  const [answers, setAnswers] = useState({})
  const [result, setResult] = useState(null)
  const [startedAt, setStartedAt] = useState(0)
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (phase !== 'running') return undefined
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [phase, startedAt])

  function begin() { setItems(shuffle(deck).slice(0, 20)); setAnswers({}); setSeconds(0); setStartedAt(Date.now()); setPhase('running') }
  function submit() { const wrong = items.filter((item) => !isCorrect(item, answers[item.id], direction)); setResult({ score: items.length - wrong.length, wrong }); setPhase('result') }

  if (!deck.length) return <EmptyDeck />
  if (phase === 'setup') return <div className="page-wrap test-setup"><span className="eyebrow">MOCK TEST · 현재 암기 덱</span><h1>시험지로 기억을 확인하세요.</h1><p>선택한 덱에서 순서를 섞어 출제합니다. 답을 직접 적은 뒤 한 번에 채점합니다.</p><div className="direction-grid"><button className={direction === 'definition' ? 'selected' : ''} onClick={() => setDirection('definition')}><b>단어 → 뜻 쓰기</b><span>단어를 보고 핵심 뜻을 직접 입력합니다.</span></button><button className={direction === 'term' ? 'selected' : ''} onClick={() => setDirection('term')}><b>뜻 → 단어 쓰기</b><span>뜻을 보고 원래 단어를 직접 입력합니다.</span></button></div><button className="primary-button" onClick={begin}>시험 시작 →</button></div>
  if (phase === 'running') return <div className="page-wrap paper-wrap"><div className="paper"><div className="paper-header"><div><b>MEMORY TEST</b><span>WORDLENS · 새 단어 모의시험</span></div><div><span>문항 <strong>{items.length}</strong></span><span>경과 <strong>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</strong></span></div></div><p>각 문항의 답을 기억에서 직접 적으세요. 정답은 제출 후에 확인합니다.</p><ol>{items.map((item) => <li key={item.id}><label>{direction === 'definition' ? <><b>{item.term}</b>의 핵심 뜻</> : <><b>{item.definition}</b>에 해당하는 단어</>}</label><input value={answers[item.id] || ''} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} /></li>)}</ol><div className="paper-footer"><button className="secondary-button" onClick={() => window.print()}>인쇄</button><button className="primary-button" onClick={submit}>답안 제출 · 채점하기 →</button></div></div></div>
  const pct = Math.round((result.score / items.length) * 100)
  return <div className="page-wrap"><section className="result"><span className="eyebrow">채점 완료</span><div className="result-score">{result.score}<small> / {items.length}</small></div><h1>{pct >= 80 ? '기억이 꽤 안정적이에요.' : '오답부터 다시 돌리면 됩니다.'}</h1><p>틀린 항목만 다시 암기 덱 맨 앞으로 보낼 수 있어요.</p>{result.wrong.length > 0 && <div className="wrong-pills">{result.wrong.map((item) => <span key={item.id}>{item.term}</span>)}</div>}<div className="completion-actions">{result.wrong.length > 0 && <button className="primary-button" onClick={() => onReview(result.wrong)}>오답만 다시 암기 →</button>}<button className="secondary-button" onClick={() => setPhase('setup')}>새 시험지 만들기</button></div></section></div>
}

function ScanPage({ onImport }) {
  const video = useRef(null)
  const canvas = useRef(null)
  const stream = useRef(null)
  const [images, setImages] = useState([])
  const [progress, setProgress] = useState('')
  const [cameraOpen, setCameraOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [status, setStatus] = useState('단어책 페이지를 촬영하거나 사진을 선택하세요.')
  const [reading, setReading] = useState(false)

  useEffect(() => () => stream.current?.getTracks().forEach((track) => track.stop()), [])

  async function openCamera() {
    try { stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); video.current.srcObject = stream.current; setCameraOpen(true); setStatus('단어와 뜻이 함께 보이도록 맞춘 뒤 촬영하세요.') } catch { setStatus('카메라를 열 수 없어요. 사진 선택을 사용해 주세요.') }
  }
  function takePhoto() { const context = canvas.current.getContext('2d'); canvas.current.width = video.current.videoWidth; canvas.current.height = video.current.videoHeight; context.drawImage(video.current, 0, 0); canvas.current.toBlob((blob) => { setImages((list) => { setStatus(`${list.length + 1}페이지 촬영 완료. 다음 페이지를 찍거나 읽기를 누르세요.`); return [...list, blob] }) }, 'image/jpeg', 0.92) }
  function selectPhoto(event) { const files = Array.from(event.target.files || []); if (files.length) { setImages((list) => { setStatus(`${list.length + files.length}페이지 준비 완료. 더 추가하거나 읽기를 누르세요.`); return [...list, ...files] }) } event.target.value = '' }
  function removePage(index) { setImages((list) => list.filter((_, i) => i !== index)) }
  async function readImage() {
    if (!images.length) return
    setReading(true)
    let worker
    try {
      worker = await createWorker('eng+kor')
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' })
      const texts = []
      for (let i = 0; i < images.length; i += 1) {
        setProgress(`${i + 1}/${images.length}페이지 읽는 중…`)
        setStatus(`${i + 1}/${images.length}페이지 읽는 중…`)
        const prepared = await preprocessForOcr(images[i])
        const { data } = await worker.recognize(prepared)
        texts.push(data.text.trim())
      }
      setRawText((prev) => [prev.trim(), ...texts].filter(Boolean).join('\n'))
      setImages([])
      setStatus('인식 완료. 단어 | 뜻 형식을 확인하고 수정해 주세요.')
    } catch { setStatus('글자를 읽지 못했어요. 사진을 더 선명하게 찍거나 직접 수정해 주세요.') } finally { await worker?.terminate(); setProgress(''); setReading(false) }
  }
  const parsed = useMemo(() => parseDeckText(rawText), [rawText])

  return <div className="page-wrap scan-page"><div><span className="eyebrow">WORD BOOK SCAN</span><h1>사진을 암기 덱으로 바꾸세요.</h1><p>단어와 뜻을 읽어 현재 암기 덱으로 가져옵니다.</p></div><section className="scanner"><div className="camera-box">{cameraOpen ? <video ref={video} autoPlay playsInline /> : <div className="camera-placeholder"><span>▧</span><b>단어책 페이지</b><small>단어와 뜻이 함께 보이게 촬영</small></div>}<canvas ref={canvas} hidden /></div><div className="scan-buttons"><button className="secondary-button" onClick={openCamera}>카메라 열기</button>{cameraOpen && <button className="primary-button" onClick={takePhoto}>사진 촬영</button>}<label className="file-button">사진 선택<input type="file" accept="image/*" multiple onChange={selectPhoto} /></label></div><p className="scan-status">{status}</p>{images.length > 0 && <div className="page-chips">{images.map((_, i) => <span key={i}>{i + 1}페이지<button disabled={reading} onClick={() => removePage(i)} aria-label={`${i + 1}페이지 삭제`}>×</button></span>)}</div>}<button className="read-button" disabled={!images.length || reading} onClick={readImage}>{reading ? (progress || '글자 읽는 중…') : `사진 ${images.length}장에서 단어와 뜻 읽기 →`}</button><textarea value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder={'단어 | 뜻 형식으로 확인·수정하세요.\n예: meticulous | 꼼꼼한, 세심한'} /><div className="import-bar"><span>{parsed.length ? `${parsed.length}개 항목을 찾았어요.` : '인식 결과를 입력하면 항목 수가 표시됩니다.'}</span><button className="primary-button" disabled={!parsed.length} onClick={() => onImport(parsed)}>암기 덱으로 가져오기 →</button></div></section></div>
}

/* OCR 정확도를 높이기 위한 전처리: 크기 보정 → 흑백 → 적응형 이진화(그림자·조명 불균일 제거) */
async function preprocessForOcr(blob) {
  const bitmap = await createImageBitmap(blob)
  const target = 2200
  const scale = Math.min(2.5, target / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const gray = new Uint8ClampedArray(w * h)
  for (let i = 0, p = 0; i < d.length; i += 4, p += 1) gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  const integral = new Float64Array((w + 1) * (h + 1))
  for (let y = 1; y <= h; y += 1) {
    let row = 0
    for (let x = 1; x <= w; x += 1) {
      row += gray[(y - 1) * w + (x - 1)]
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row
    }
  }
  const r = Math.max(15, Math.round(Math.min(w, h) / 24))
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r)
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r)
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const sum = integral[(y1 + 1) * (w + 1) + x1 + 1] - integral[y0 * (w + 1) + x1 + 1] - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0]
      const v = gray[y * w + x] < (sum / area) * 0.9 ? 0 : 255
      const o = (y * w + x) * 4
      d[o] = d[o + 1] = d[o + 2] = v
      d[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return await new Promise((resolve) => cv.toBlob(resolve, 'image/png'))
}

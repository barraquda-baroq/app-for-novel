// セパレート画面: 採用した話（または幕）の本文に分割点を置き、幕に分ける。
// 本文は読み取り専用で、区切りごとの入力欄に並べる（クリック・タップでカーソルを置ける。キーボードは出さない）。
// 読み取り専用の入力欄にはブラウザがカーソルを描かないので、カーソルの位置に印（縦線）を自分で描く。
// カーソルを置いて Enter か「ここで区切る」（決定）で分割点を足す。分割点は「ここから第2幕」の区切り線になり、× で外せる。
// 右（スマホでは上）に、分けた後の幕の一覧（第x幕・最初の行・文字数）を出す。「幕に分ける」で確定する。
// スマホでは「ここで区切る」を画面の下（キーボードが出ていればそのすぐ上）に置く（原稿画面の記号バーと同じ）。
// 分ける前に、保存されていない編集の控え（原稿画面で保存しなかった編集）があれば伝える（分けるのは保存した本文）。
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { actLabel, actNumber, episodeNumbers, isSplit, locatePiece, parentOf, pieceLabel } from '../../domain/structure'
import { bodyMetrics, formatCount } from '../../domain/text'
import type { ID, Piece, Title, Version } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { useSync } from '../../sync/controller'
import { formatDateTime } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { useDocumentTitle, useMediaQuery } from '../../ui/hooks'
import { XIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { COPIED } from '../piece/caret'
import { useIosEditorKeyboard } from '../../platform/keyboard'
import { useKeyboardInset } from '../piece/keyboardInset'
import { activeVersionOf } from '../piece/logic'
import { confirmPendingDrafts, pendingDrafts, type PendingDraft } from './actFlows'
import { ScissorsIcon } from './actIcons'
import './acts.css'
import { addPointAt, displayValue, previewActs, SEPARATE_FROM_PIECE, segmentsOf } from './separateLogic'

export function SeparatePage() {
  const { titleId = '', pieceId = '' } = useParams()
  const data = useData()
  const title = data.titles[titleId]
  const piece = data.pieces[pieceId]
  if (!title || !piece || piece.titleId !== title.id) {
    return <NotFound message="話が見つかりません。削除された可能性があります。" />
  }
  return <SeparateView key={piece.id} title={title} piece={piece} />
}

/** 押してもフォーカスを動かさない（入力欄のカーソルを残す） */
const keepFocus = (e: SyntheticEvent) => e.preventDefault()

/** 古い版のアプリについての案内を、この端末で出したか（端末ごとに一度だけ出す） */
const OTHER_DEVICES_NOTICE_KEY = 'novel-studio:acts-other-devices-notice'

function otherDevicesNoticeShown(): boolean {
  try {
    return localStorage.getItem(OTHER_DEVICES_NOTICE_KEY) === '1'
  } catch {
    return true
  }
}

function markOtherDevicesNoticeShown(): void {
  try {
    localStorage.setItem(OTHER_DEVICES_NOTICE_KEY, '1')
  } catch {
    /* noop */
  }
}

/**
 * 同期している端末で初めて分ける時に、ほかの端末のアプリを先に新しくするよう一度だけ伝える。
 * 古い版（2.1 まで）は幕を知らないので、幕がふつうの話として並び、そこで幕を削除すると幕の並びが崩れる。分けるなら true
 */
async function confirmOtherDevices(): Promise<boolean> {
  if (!useSync.getState().everSignedIn || otherDevicesNoticeShown()) return true
  const ok = await confirmDialog({
    title: 'ほかの端末のアプリを先に新しくしてください',
    message:
      '古い版（2.1 まで）のアプリでは、幕がふつうの話（第n話）として並び、話数や文字数がずれて見えます。古い版で幕を削除すると、この端末でも幕がなくなります。' +
      '\n\nほかのパソコン・iPhone・Android のアプリを最新にしてから分けてください（この案内はこの端末で一度だけ出ます）。',
    confirmLabel: '分ける',
  })
  if (ok) markOtherDevicesNoticeShown()
  return ok
}

/** 話・幕に保存されていない編集の控えがあるか（別のタブで編集中のものも） */
function usePendingDraft(pieceId: ID): PendingDraft | null {
  const [pending, setPending] = useState<PendingDraft | null>(null)
  useEffect(() => {
    let alive = true
    void pendingDrafts([pieceId]).then((list) => {
      if (alive) setPending(list[0] ?? null)
    })
    return () => {
      alive = false
    }
  }, [pieceId])
  return pending
}

function SeparateView({ title, piece }: { title: Title; piece: Piece }) {
  const data = useData()
  const navigate = useNavigate()
  useKeyboardInset()
  useIosEditorKeyboard()
  const wide = useMediaQuery('(min-width: 900px)')
  const isAct = piece.kind === 'act'
  const parent = isAct ? parentOf(data, piece) : undefined
  const episode = parent ?? piece
  const numbers = useMemo(() => episodeNumbers(data, title.id), [data, title.id])
  const epLabel = pieceLabel(data, episode, numbers)
  const firstNumber = isAct ? (actNumber(data, piece) ?? 1) : 1
  const version = activeVersionOf(data, piece)
  const slot = locatePiece(data, episode.id)
  const chapter = title.chaptersEnabled && slot?.chapterId ? data.chapters[slot.chapterId] : undefined
  const canSplit = piece.kind !== 'special' && !isSplit(piece) && version !== null && (!isAct || parent !== undefined)

  const heading = [epLabel, episode.subtitle.trim(), isAct ? actLabel(firstNumber) : ''].filter(Boolean).join('　')
  useDocumentTitle(`セパレート: ${heading} — ${title.name}`)

  const crumbs: Crumb[] = [{ label: title.name || '無題のタイトル', to: paths.title(title.id) }]
  if (chapter) crumbs.push({ label: chapter.name || '（無題の章）', to: paths.chapter(title.id, chapter.id) })
  crumbs.push({ label: epLabel, to: paths.piece(title.id, episode.id) })
  if (isAct) crumbs.push({ label: actLabel(firstNumber), to: paths.piece(title.id, piece.id) })
  crumbs.push({ label: isAct ? 'さらに分ける' : 'セパレート' })

  // キャンセル: 開いた元（原稿画面・一覧）へ戻る。直接開いた時は原稿画面へ
  const location = useLocation()
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate(paths.piece(title.id, piece.id), { replace: true }))

  if (!canSplit || !version) {
    const reason = isSplit(piece)
      ? 'この話はもう幕に分けてあります。幕の画面の「さらに分ける」で分けてください。'
      : piece.kind === 'special'
        ? '特殊ブロックは幕に分けられません。'
        : '採用原稿がないため分けられません。先に稿を採用してください。'
    return (
      <>
        <AppHeader crumbs={crumbs} />
        <main className="page page-narrow">
          <div className="card card-pad stack" data-testid="separate-unavailable">
            <p style={{ margin: 0 }}>{reason}</p>
            <div className="row">
              <Link to={paths.piece(title.id, piece.id)} className="btn">
                戻る
              </Link>
            </div>
          </div>
        </main>
      </>
    )
  }

  return (
    <SplitEditor
      // 本文が変わったら（同期で別の端末の編集が届いた等）、置いた分割点は捨てて置き直してもらう
      key={`${version.id}:${bodyMetrics(version).hash}:${version.body.length}`}
      title={title}
      piece={piece}
      version={version}
      heading={heading}
      firstNumber={firstNumber}
      wide={wide}
      crumbs={crumbs}
      onCancel={back}
    />
  )
}

interface SplitEditorProps {
  title: Title
  piece: Piece
  version: Version
  heading: string
  firstNumber: number
  wide: boolean
  crumbs: Crumb[]
  onCancel: () => void
}

/** カーソルの前後の数文字（「…で区切れます」の知らせに出す。改行は ↵） */
function around(value: string, offset: number): string {
  const show = (s: string) => s.replace(/\n/g, '↵')
  return `${show(value.slice(Math.max(0, offset - 6), offset))}｜${show(value.slice(offset, offset + 6))}`
}

function SplitEditor({ title, piece, version, heading, firstNumber, wide, crumbs, onCancel }: SplitEditorProps) {
  const navigate = useNavigate()
  const location = useLocation()
  // 原稿画面から開いた時は、分けた後にその履歴へ戻る（同じ URL を二重に積まない。Android の「戻る」1回で一覧へ戻れるように）
  const fromPiece = (location.state as Record<string, unknown> | null)?.[SEPARATE_FROM_PIECE] === true
  const body = version.body
  const [points, setPoints] = useState<number[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = usePendingDraft(piece.id)
  const segments = useMemo(() => segmentsOf(body, points), [body, points])
  const preview = useMemo(() => previewActs(segments, firstNumber), [segments, firstNumber])
  const areas = useRef<(HTMLTextAreaElement | null)[]>([])
  const dividers = useRef<(HTMLDivElement | null)[]>([])
  /** 最後にカーソルを置いた所（区切りの番号と、入力欄の値での位置） */
  const caret = useRef<{ segment: number; offset: number } | null>(null)
  /** 描いた後にカーソルを置く所 */
  const pendingFocus = useRef<{ segment: number; offset: number; reveal: number | null } | null>(null)
  const isAct = piece.kind === 'act'

  const remember = (segment: number) => (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const offset = el.selectionStart
    const prev = caret.current
    caret.current = { segment, offset }
    // カーソルを動かした時は、どこで区切れるかを知らせる（読み上げにも。区切りを足した直後の知らせは残す）
    if (prev && prev.segment === segment && prev.offset === offset) return
    setMessage(`${actLabel(firstNumber + segment)}の「${around(el.value, offset)}」で区切れます`)
  }

  const add = (segment: number, offset: number) => {
    // 区切れなかった時の知らせを、遅れて届く同じ位置のカーソルの知らせで上書きしない
    caret.current = { segment, offset }
    const r = addPointAt(body, points, segment, offset)
    if (!r.ok) {
      setMessage(r.message)
      return
    }
    setPoints(r.points)
    setMessage(`ここから${actLabel(firstNumber + segment + 1)}にします`)
    caret.current = { segment: segment + 1, offset: 0 }
    pendingFocus.current = { segment: segment + 1, offset: 0, reveal: segment }
  }

  /** 分割点 index（index 番目の区切りの後ろ）を外す */
  const remove = (index: number) => {
    const joinAt = displayValue(segments[index].text).length
    setPoints(points.filter((_, i) => i !== index))
    setMessage(`${actLabel(firstNumber + index + 1)}の区切りを外しました`)
    caret.current = { segment: index, offset: joinAt }
    pendingFocus.current = { segment: index, offset: joinAt, reveal: null }
  }

  // 区切りを足した・外した後は、新しい区切りの先頭（外した所）にカーソルを置き、区切り線が見えるようにする
  useLayoutEffect(() => {
    const p = pendingFocus.current
    if (!p) return
    pendingFocus.current = null
    const el = areas.current[p.segment]
    if (el) {
      el.focus({ preventScroll: true })
      el.setSelectionRange(p.offset, p.offset)
      // カーソルの印を置き直す（setSelectionRange では select が届かないブラウザがある）
      el.dispatchEvent(new Event('select', { bubbles: true }))
    }
    const target = p.reveal !== null ? dividers.current[p.reveal] : el
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [points])

  const onKeyDown = (segment: number) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const el = e.currentTarget
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      add(segment, el.selectionStart)
    } else if (e.key === 'Backspace' && segment > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
      // 区切りの先頭で Backspace: その区切りを外す
      e.preventDefault()
      remove(segment - 1)
    }
  }

  /** 「ここで区切る」: 入力欄にカーソルがあればその位置、なければ最後に置いた位置 */
  const decide = () => {
    const active = document.activeElement
    const i = areas.current.findIndex((a) => a !== null && a === active)
    if (i >= 0) {
      add(i, (active as HTMLTextAreaElement).selectionStart)
      return
    }
    const c = caret.current
    if (!c) {
      setMessage('区切りたい所をクリック（タップ）してカーソルを置いてください')
      return
    }
    add(c.segment, c.offset)
  }

  const apply = async () => {
    if (points.length === 0 || busy) return
    setBusy(true)
    try {
      // 保存されていない編集の控え（分けるのは保存した本文）と、古い版のアプリの案内
      if (!(await confirmPendingDrafts([piece.id], { open: (id) => navigate(paths.piece(title.id, id)) }))) return
      if (!(await confirmOtherDevices())) return
      const ids = attempt(() => actions.separatePiece(piece.id, points))
      if (!ids) return
      notify(
        isAct ? `${actLabel(firstNumber)}を${segments.length}つに分けました` : `「${heading}」を${segments.length}幕に分けました`,
      )
      if (fromPiece) navigate(-1)
      else navigate(paths.piece(title.id, piece.id), { replace: true })
    } finally {
      setBusy(false)
    }
  }

  const previewList = (
    <ol className="sep-preview-list" data-testid="separate-preview">
      {preview.map((p) => (
        <li key={p.number} className="sep-preview-item" data-testid="separate-preview-item">
          <span className="sep-preview-label">{actLabel(p.number)}</span>
          <span className="sep-preview-line">{p.firstLine || '（空行だけ）'}</span>
          <span className="sep-preview-count">{formatCount(p.chars)}字</span>
        </li>
      ))}
    </ol>
  )
  const lastNumber = firstNumber + segments.length - 1
  const previewSummary =
    points.length === 0
      ? 'まだ区切っていません'
      : `${actLabel(firstNumber)}〜${actLabel(lastNumber)}の${segments.length}${isAct ? 'つ' : '幕'}に分かれます`

  // キャンセル・幕に分ける。広い画面ではヘッダー、狭い画面では見出しの横（ヘッダーのパンくずを削らない）
  const headActions = (
    <div className="sep-head-actions">
      <button type="button" className="btn btn-sm" onClick={onCancel} data-testid="separate-cancel">
        キャンセル
      </button>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => void apply()}
        disabled={points.length === 0 || busy}
        title={points.length === 0 ? '区切る位置を1つ以上置いてください' : undefined}
        data-testid="separate-apply"
      >
        {isAct ? '分ける' : '幕に分ける'}
      </button>
    </div>
  )

  return (
    <div className="sep-root" data-testid="separate-page">
      <AppHeader crumbs={crumbs} actions={wide ? headActions : undefined} />
      <div className="sep-intro">
        <div className="sep-intro-head">
          <h1 className="sep-title" data-testid="separate-heading">
            {heading}
          </h1>
          {wide ? null : headActions}
        </div>
        <p className="sep-help">
          区切りたい所をクリック（タップ）してカーソルを置き、<kbd>Enter</kbd> か「ここで区切る」を押します。本文は変わりません
          {isAct ? '（後ろの幕の番号は繰り下がります）' : '（話数も変わりません）'}。
        </p>
        {pending ? (
          <p className="sep-draft-notice" role="note" data-testid="separate-draft-notice">
            {pending.alive
              ? 'この話（幕）は別のタブ・ウィンドウで編集中です。分けるのは保存した本文なので、その編集は入りません。'
              : `この話（幕）には、前回保存されなかった編集の控えがあります（${formatDateTime(pending.draft.at)}）。分けるのは保存した本文なので、その編集は入りません。`}
            {pending.alive ? null : (
              <>
                {' '}
                <Link to={paths.piece(title.id, piece.id)} data-testid="separate-draft-open">
                  開いて確かめる
                </Link>
              </>
            )}
          </p>
        ) : null}
      </div>
      <div className="sep-main">
        <div className="sep-text" data-testid="separate-body">
          <div className="sep-act-head" aria-hidden="true">
            {actLabel(firstNumber)}
          </div>
          {segments.map((s, i) => (
            <div key={`${s.start}`} className="sep-segment">
              {i > 0 ? (
                <div
                  ref={(el) => {
                    dividers.current[i - 1] = el
                  }}
                  className="sep-divider"
                  role="separator"
                  aria-label={`ここから${actLabel(firstNumber + i)}`}
                  data-testid="split-divider"
                >
                  <span className="sep-divider-label">ここから{actLabel(firstNumber + i)}</span>
                  <button
                    type="button"
                    className="icon-btn sep-divider-remove"
                    onClick={() => remove(i - 1)}
                    aria-label={`${actLabel(firstNumber + i)}の区切りを外す`}
                    title="この区切りを外す"
                    data-testid="remove-split"
                  >
                    <XIcon />
                  </button>
                </div>
              ) : null}
              <SegmentArea
                areaRef={(el) => {
                  areas.current[i] = el
                }}
                text={s.text}
                label={`${actLabel(firstNumber + i)}の本文（読み取り専用。カーソルを置いて Enter で区切る）`}
                onCaret={remember(i)}
                onKeyDown={onKeyDown(i)}
              />
            </div>
          ))}
        </div>
        <aside className="sep-preview" aria-label="分けた後の幕">
          {wide ? (
            <>
              <h2 className="sep-preview-title">分けた後</h2>
              <p className="sep-preview-summary" data-testid="separate-summary">
                {previewSummary}
              </p>
              {previewList}
            </>
          ) : (
            <details className="sep-preview-details">
              <summary data-testid="separate-summary">{previewSummary}</summary>
              {previewList}
            </details>
          )}
        </aside>
      </div>
      <div className="sep-bar" data-testid="separate-bar" onPointerDown={keepFocus} onMouseDown={keepFocus}>
        <p className="sep-message" role="status" aria-live="polite" data-testid="separate-message">
          {message}
        </p>
        <button type="button" className="btn btn-primary sep-decide" onClick={decide} data-testid="separate-decide">
          <ScissorsIcon />
          ここで区切る
        </button>
      </div>
    </div>
  )
}

/** カーソルの印の位置（入力欄を包む要素の中の座標） */
interface CaretMark {
  x: number
  y: number
  h: number
}

const ZWSP = '​'

/**
 * 入力欄の pos の位置（行の上端・左端と行の高さ）を、同じ書式の見えない要素で測る。
 * 読み取り専用の入力欄にはブラウザがカーソルを描かないので、その位置に自分で印を描くのに使う
 */
function measureCaret(el: HTMLTextAreaElement, pos: number): CaretMark {
  const cs = getComputedStyle(el)
  const mirror = document.createElement('div')
  const s = mirror.style
  for (const p of COPIED) s[p] = cs[p]
  s.position = 'absolute'
  s.visibility = 'hidden'
  s.top = '0'
  s.left = '-99999px'
  s.boxSizing = 'border-box'
  s.border = '0'
  // スクロールバーを除いた幅（余白を含む）で折り返す
  s.width = `${el.clientWidth}px`
  s.whiteSpace = 'pre-wrap'
  s.overflowWrap = 'break-word'
  mirror.textContent = el.value.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = ZWSP
  // 行の高さの箱にして、行の上端に揃える（文字の高さではなく行の高さの印にする）
  const lineHeight = parseFloat(cs.lineHeight)
  marker.style.display = 'inline-block'
  marker.style.verticalAlign = 'top'
  if (Number.isFinite(lineHeight)) marker.style.height = `${lineHeight}px`
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const x = marker.offsetLeft
  const y = marker.offsetTop
  const h = marker.offsetHeight || lineHeight || 20
  mirror.remove()
  return {
    x: el.offsetLeft + el.clientLeft + x - el.scrollLeft,
    y: el.offsetTop + el.clientTop + y - el.scrollTop,
    h,
  }
}

/** 区切り1つ分の本文（読み取り専用。高さは中身に合わせ、画面全体でスクロールする）。カーソルのある所に印を描く */
function SegmentArea({
  areaRef,
  text,
  label,
  onCaret,
  onKeyDown,
}: {
  areaRef: (el: HTMLTextAreaElement | null) => void
  text: string
  label: string
  onCaret: (e: SyntheticEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const value = useMemo(() => displayValue(text), [text])
  const [mark, setMark] = useState<CaretMark | null>(null)
  /** 印を置いた時のカーソルの位置と幅（同じなら測り直さない） */
  const measured = useRef<string>('')

  /** カーソルの印を置き直す（フォーカスが無ければ消す） */
  const updateMark = (force = false) => {
    const el = ref.current
    if (!el || document.activeElement !== el) {
      measured.current = ''
      setMark(null)
      return
    }
    const key = `${el.selectionStart}|${el.selectionEnd}|${el.clientWidth}`
    if (!force && key === measured.current) return
    measured.current = key
    setMark(measureCaret(el, el.selectionEnd))
  }
  const updateRef = useRef(updateMark)
  updateRef.current = updateMark

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + 2}px`
      updateRef.current(true)
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [value])

  // プログラムでカーソルを動かした時も（区切りを足した後など）、印を追う
  useEffect(() => {
    const onSelectionChange = () => {
      if (document.activeElement === ref.current) updateRef.current()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  const caretEvent = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    onCaret(e)
    updateMark()
  }

  let caretMark: ReactNode = null
  if (mark) {
    caretMark = (
      <span
        className="sep-caret"
        aria-hidden="true"
        style={{ left: mark.x, top: mark.y, height: mark.h }}
        data-testid="separate-caret"
      />
    )
  }

  return (
    <div className="sep-area-wrap">
      <textarea
        ref={(el) => {
          ref.current = el
          areaRef(el)
        }}
        className="manuscript sep-area"
        value={value}
        readOnly
        // 読み取り専用でもキーボードを出さない（カーソルを置くだけ）
        inputMode="none"
        spellCheck={false}
        rows={1}
        aria-label={label}
        onSelect={caretEvent}
        onKeyUp={caretEvent}
        onMouseUp={caretEvent}
        onPointerUp={caretEvent}
        onFocus={caretEvent}
        onBlur={() => updateMark()}
        onKeyDown={onKeyDown}
        data-testid="separate-text"
      />
      {caretMark}
    </div>
  )
}

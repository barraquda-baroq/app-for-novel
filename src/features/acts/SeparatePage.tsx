// セパレート画面: 採用した話（または幕）の本文に分割点を置き、幕に分ける。
// 本文は読み取り専用で、区切りごとの入力欄に並べる（クリック・タップでカーソルを置ける。キーボードは出さない）。
// カーソルを置いて Enter か「ここで区切る」（決定）で分割点を足す。分割点は「ここから第2幕」の区切り線になり、× で外せる。
// 右（スマホでは上）に、分けた後の幕の一覧（第x幕・最初の行・文字数）を出す。「幕に分ける」で確定する。
// スマホでは「ここで区切る」を画面の下（キーボードが出ていればそのすぐ上）に置く（原稿画面の記号バーと同じ）。
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { actLabel, actNumber, episodeNumbers, isSplit, locatePiece, parentOf, pieceLabel } from '../../domain/structure'
import { formatCount } from '../../domain/text'
import type { Piece, Title, Version } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { useDocumentTitle, useMediaQuery } from '../../ui/hooks'
import { XIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { useKeyboardInset } from '../piece/keyboardInset'
import { activeVersionOf } from '../piece/logic'
import { ScissorsIcon } from './actIcons'
import './acts.css'
import { addPointAt, displayValue, previewActs, segmentsOf } from './separateLogic'

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

function SeparateView({ title, piece }: { title: Title; piece: Piece }) {
  const data = useData()
  const navigate = useNavigate()
  useKeyboardInset()
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
      key={version.id}
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

function SplitEditor({ title, piece, version, heading, firstNumber, wide, crumbs, onCancel }: SplitEditorProps) {
  const navigate = useNavigate()
  const body = version.body
  const [points, setPoints] = useState<number[]>([])
  const [message, setMessage] = useState('')
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
    caret.current = { segment, offset: e.currentTarget.selectionStart }
  }

  const add = (segment: number, offset: number) => {
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

  const apply = () => {
    if (points.length === 0) return
    const ids = attempt(() => actions.separatePiece(piece.id, points))
    if (!ids) return
    notify(isAct ? `${actLabel(firstNumber)}を${segments.length}つに分けました` : `${heading}を${segments.length}幕に分けました`)
    navigate(paths.piece(title.id, piece.id), { replace: true })
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

  return (
    <div className="sep-root" data-testid="separate-page">
      <AppHeader
        crumbs={crumbs}
        actions={
          <div className="sep-head-actions">
            <button type="button" className="btn btn-sm" onClick={onCancel} data-testid="separate-cancel">
              キャンセル
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={apply}
              disabled={points.length === 0}
              title={points.length === 0 ? '区切る位置を1つ以上置いてください' : undefined}
              data-testid="separate-apply"
            >
              {isAct ? '分ける' : '幕に分ける'}
            </button>
          </div>
        }
      />
      <div className="sep-intro">
        <h1 className="sep-title" data-testid="separate-heading">
          {heading}
        </h1>
        <p className="sep-help">
          区切りたい所をクリック（タップ）してカーソルを置き、<kbd>Enter</kbd> か「ここで区切る」を押します。本文は変わりません
          {isAct ? '（後ろの幕の番号は繰り下がります）' : '（話数も変わりません）'}。
        </p>
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

/** 区切り1つ分の本文（読み取り専用。高さは中身に合わせ、画面全体でスクロールする） */
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
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + 2}px`
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
  return (
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
      onSelect={onCaret}
      onKeyUp={onCaret}
      onMouseUp={onCaret}
      onPointerUp={onCaret}
      onFocus={onCaret}
      onKeyDown={onKeyDown}
      data-testid="separate-text"
    />
  )
}

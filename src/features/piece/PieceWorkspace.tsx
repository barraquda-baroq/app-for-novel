// 原稿画面（このアプリの肝）。
// 採用原稿（左／上）と推敲バージョン（右／下）を同じ画面に並べ、比率はスライダーと境界のドラッグで変えられる。
// ?v=<versionId> で比較する推敲バージョンを選ぶ。
// スマホ（狭い画面・高さの低い画面）では、本文などを編集している間は画面上部を畳む（集中モード）。
// 本文・稿の名前・推敲メモ・話の題・見出しの編集は「保存」を押すまで画面の中だけで持つ（usePieceSession.ts）。
// いちばん下に記号バー（巻き戻し／進む・ダッシュ・三点リーダー・全角空白・ルビ・傍点）を置く。
// 幕（セパレート）も同じ画面で編集する（見出しは「第3話　題　第2幕」、前後の移動は同じ話の中の幕）。
// 幕に分けた話は、話自身の本文は編集せず、幕の一覧（EpisodeFolder）を出す。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { joinError, unseparateError } from '../../domain/acts'
import {
  activeVersion,
  actLabel,
  actNumber,
  actsOf,
  episodeNumbers,
  isSplit,
  locatePiece,
  parentOf,
  pieceFullLabel,
  pieceLabel,
} from '../../domain/structure'
import { openProofSuggestionsFor } from '../../claude/order'
import type { AppData, ID, Piece, Title } from '../../domain/types'
import { paths, PROOF_PARAM } from '../../routes'
import { getData, useData } from '../../store/appStore'
import { usePrefs } from '../../store/uiStore'
import { useDocumentTitle, useMediaQuery, useSplitOrientation } from '../../ui/hooks'
import { BookIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import type { PopupMenuItem } from '../../ui/PopupMenu'
import { SplitPane } from '../../ui/SplitPane'
import { confirmJoin, confirmUnseparate } from '../acts/actFlows'
import { ActsIcon, JoinActsIcon, ScissorsIcon, SplitActsIcon, UnsplitIcon } from '../acts/actIcons'
import { SEPARATE_FROM_PIECE } from '../acts/separateLogic'
import { EpisodeFolder } from '../acts/EpisodeFolder'
import { ActivePane } from './ActivePane'
import { isTypingWithin, useHeldWhile, useLocalFlag, useScrollSync, useTypingFocus } from './editing'
import { useKeyboardInset } from './keyboardInset'
import { activeVersionOf, actNeighbors, neighborPieces, pieceHeading, resolveSelected } from './logic'
import { PieceBar } from './PieceBar'
import './piece.css'
import { ProofChip, ProofPanel, useProofJump } from './ProofPanel'
import { SaveControls } from './SaveControls'
import { readCrashDraft, type CrashDraft } from './crashDraft'
import { askOrphanDrafts, orphanState, type LastSeen } from './orphan'
import { OrphanEdits } from './OrphanEdits'
import { pieceField } from './session'
import { SymbolBar } from './SymbolBar'
import { usePieceSession, type PieceSession } from './usePieceSession'
import { VersionsPane, type WorkspaceApi } from './VersionsPane'

/** 一覧から比較を開いた履歴の印（history.state に入れる） */
const COMPARE_FROM_LIST = 'pwCompareFromList'
type CompareHistoryState = { [COMPARE_FROM_LIST]?: boolean }

export function PieceWorkspace() {
  const { titleId = '', pieceId = '' } = useParams()
  // 話を切り替えたら画面内の状態（ポップオーバー・編集セッション等）をリセットする
  return <PieceHost key={pieceId} titleId={titleId} pieceId={pieceId} />
}

/** 原稿画面で開ける幕か（属する話の幕の並びに載っている） */
const isListedAct = (data: AppData, piece: Piece) => piece.kind !== 'act' || actNumber(data, piece) !== null

/**
 * 編集セッションを URL の話・幕ごとに持つ（原稿画面・幕に分けた話の画面・見つからない時の表示をまたいで）。
 * 別の画面・端末で、開いている幕がつながれた・セパレートを解除された・削除された、話が幕に分けられた時も、
 * 保存していない編集があれば黙って消さず、残す画面（OrphanEdits）を出す（画面を離れる時の確認・端末内の控えも続ける）
 */
function PieceHost({ titleId, pieceId }: { titleId: ID; pieceId: ID }) {
  const data = useData()
  const title = data.titles[titleId]
  const found = data.pieces[pieceId]
  const piece = title && found && found.titleId === title.id ? found : undefined
  const parent = piece?.kind === 'act' ? parentOf(data, piece) : undefined
  const viewable = piece !== undefined && isListedAct(data, piece)

  // 最後に見えていた場所（幕が無くなった後の、編集の残し先を決めるのに使う）と、残す幕の選択
  const last = useRef<LastSeen | null>(null)
  const [choice, setChoice] = useState<ID | null>(null)
  const choiceRef = useRef(choice)
  choiceRef.current = choice
  const keepTarget = useCallback(
    () => orphanState(getData(), titleId, pieceId, last.current)?.keep(choiceRef.current) ?? null,
    [titleId, pieceId],
  )
  const ps = usePieceSession(pieceId, { restore: viewable, keepTarget })
  const { session } = ps

  useLayoutEffect(() => {
    if (!piece || !viewable) return
    const acts = parent ? actsOf(data, parent) : []
    const index = parent ? acts.findIndex((a) => a.id === piece.id) : -1
    const prevId = index > 0 ? acts[index - 1].id : null
    last.current = { titleId, parentId: parent?.id ?? null, index, prevId, label: pieceFullLabel(data, piece) }
    // 端末内の控えにも幕の場所を書く（幕が無くなった後で、残った幕・話を開いた時に聞けるように）
    session.context = parent ? { parentId: parent.id, prevId, index } : {}
  }, [data, piece, parent, viewable, titleId, session])

  // なくなった幕の控え（アプリが落ちる等で残っていた、つないだ・解除した幕の編集）は、残った幕・話を開いた時に聞く
  const scope = viewable && !ps.dirty ? (parent?.id ?? (piece.kind === 'episode' ? piece.id : null)) : null
  const scopeActs = scope ? (data.pieces[scope]?.actIds ?? []).join(',') : ''
  useOrphanDrafts(scope, scopeActs, pieceId)

  if (ps.dirty) {
    const orphan = orphanState(data, titleId, pieceId, last.current)
    if (orphan) {
      return <OrphanEdits title={title} state={orphan} last={last.current} ps={ps} choice={choice} onChoice={setChoice} />
    }
  }
  if (!title || !piece || !viewable) {
    if (piece?.kind !== 'act' && !last.current?.parentId) {
      return <NotFound message="話が見つかりません。削除された可能性があります。" />
    }
    // 無くなった幕: 属していた話が残っていれば、そこへ移れるようにする
    const lostParentId = last.current?.parentId ?? readCrashDraft(pieceId)?.parentId ?? piece?.parentId
    const lostParent = lostParentId ? data.pieces[lostParentId] : undefined
    return (
      <NotFound
        message="幕が見つかりません。つないだり、セパレートを解除したりした可能性があります。"
        action={
          lostParent && lostParent.kind === 'episode'
            ? { to: paths.piece(lostParent.titleId, lostParent.id), label: `「${pieceFullLabel(data, lostParent)}」を開く` }
            : undefined
        }
      />
    )
  }
  // 幕に分けた話: 幕の一覧（話自身の本文は編集しない）
  if (isSplit(piece)) return <EpisodeFolder title={title} piece={piece} />
  return <Workspace title={title} piece={piece} ps={ps} />
}

/**
 * 話 scope の、なくなった幕の控えを聞く（scope が変わった時・幕の並びが変わった時に見直す。聞いた控えは開いている間は聞き直さない）。
 * 残し先は、控えに書いた前の幕（つないだ時に本文を引き継いだ幕）、なければ開いている幕か第1幕。分けていない話ならその話
 */
function useOrphanDrafts(scope: ID | null, scopeActs: string, current: ID): void {
  const asked = useRef(new Set<ID>())
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!scope) return
    const targetFor = (draft: CrashDraft) => {
      const d = getData()
      const p = d.pieces[scope]
      if (!p || p.kind !== 'episode') return undefined
      if (!isSplit(p)) return p
      const acts = actsOf(d, p)
      return acts.find((a) => a.id === draft.prevId) ?? acts.find((a) => a.id === current) ?? acts[0]
    }
    void askOrphanDrafts(scope, targetFor, asked.current, () => mounted.current)
  }, [scope, scopeActs, current])
}

function Workspace({ title, piece, ps }: { title: Title; piece: Piece; ps: PieceSession }) {
  const data = useData()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const autoOrientation = useSplitOrientation()
  const orientationPref = usePrefs((s) => s.splitOrientation)
  const splitRatio = usePrefs((s) => s.splitRatio)
  const showDiff = usePrefs((s) => s.showDiff)
  const setPrefs = usePrefs((s) => s.setPrefs)
  const [scrollSync, setScrollSync] = useLocalFlag('novel-studio:piece-scroll-sync', false)

  const rootRef = useRef<HTMLDivElement>(null)
  const { session, hub, dirty, save, discard, ensureSaved } = ps
  useKeyboardInset()

  const numbers = useMemo(() => episodeNumbers(data, title.id), [data, title.id])
  // 幕は、属する話の話数・題・章を見出しと位置に使う
  const isAct = piece.kind === 'act'
  const parent = isAct ? parentOf(data, piece) : undefined
  const episode = parent ?? piece
  const actNo = isAct ? actNumber(data, piece) : null
  const actName = actNo ? actLabel(actNo) : null
  const label = pieceLabel(data, episode, numbers)
  const slot = useMemo(() => locatePiece(data, episode.id), [data, episode.id])
  const chapter = title.chaptersEnabled && slot?.chapterId ? data.chapters[slot.chapterId] : undefined
  const neighbors = useMemo(
    () => (parent ? actNeighbors(data, parent, piece.id) : neighborPieces(data, title.id, piece.id)),
    [data, parent, title.id, piece.id],
  )

  const active = activeVersionOf(data, piece)
  const requested = params.get('v')
  const selected = resolveSelected(data, piece, requested)

  // 入力中の欄（ペインの中なら、スマホでは集中モード）。編集中の欄が作り直される時は判定し直す
  const typing = useTypingFocus(rootRef, '.pw-split', `${active?.id ?? ''}|${selected?.id ?? ''}|${showDiff ? 1 : 0}`)
  const writing = typing === 'area'
  // 指で操作する端末では、仮想キーボードの開閉で画面の縦横比が変わっても、入力中は分割の向きを変えない
  // （キーボードはフォーカスの直後に出るので、typing の反映を待たずに今のフォーカスも見る）
  const touch = useMediaQuery('(pointer: coarse)')
  const holdOrientation = touch && orientationPref === 'auto' && (typing !== null || isTypingWithin('.pw-root'))
  const orientation = useHeldWhile(autoOrientation, holdOrientation)

  useDocumentTitle(
    `${label}${episode.subtitle.trim() ? ` ${episode.subtitle.trim()}` : ''}${actName ? ` ${actName}` : ''} — ${title.name}`,
  )

  // 削除済み・別の話のバージョンを指す ?v は落として一覧表示にする
  useEffect(() => {
    if (requested && !selected) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('v')
          return next
        },
        { replace: true },
      )
    }
  }, [requested, selected, setParams])

  // 一覧から比較を開いた時は履歴に積む（ブラウザ・Android の「戻る」で一覧に戻れるように）。
  // 比較中にバージョンを切り替える時は積まない。一覧に戻る時は、積んだ履歴があればそれを戻る。
  const historyState = location.state as CompareHistoryState | null
  const openedFromList = historyState?.[COMPARE_FROM_LIST] === true
  const select = useCallback(
    (versionId: ID | null) => {
      if (!versionId && requested && openedFromList) {
        navigate(-1)
        return
      }
      const entering = Boolean(versionId) && !requested
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (versionId) next.set('v', versionId)
          else next.delete('v')
          return next
        },
        entering ? { state: { [COMPARE_FROM_LIST]: true } } : { replace: true, state: versionId ? historyState : null },
      )
    },
    [setParams, navigate, requested, openedFromList, historyState],
  )

  const comparing = Boolean(selected)
  useScrollSync(scrollSync && comparing, rootRef, `${active?.id ?? ''}|${selected?.id ?? ''}|${showDiff ? 1 : 0}|${orientation}`)

  // 推敲案（2.3）: この話・幕のチェックしていない推敲案の「推敲案 n」と一覧。?ps=<id> で開いた時はその箇所を選ぶ
  const openProof = useMemo(
    () => openProofSuggestionsFor(data, piece.id),
    [data.proofSuggestions, data.pieces, piece.id], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [proofOpen, setProofOpen] = useState(false)
  const [proofFocus, setProofFocus] = useState<ID | null>(null)
  const jumpToProof = useProofJump(title.id, piece, active, hub)
  const proofParam = params.get(PROOF_PARAM)
  useEffect(() => {
    if (!proofParam) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete(PROOF_PARAM)
        return next
      },
      { replace: true },
    )
    const s = getData().proofSuggestions[proofParam]
    if (!s) return
    setProofFocus(s.id)
    // 狭い画面では一覧を開かず、本文のその箇所だけを見せる
    if (!window.matchMedia?.('(max-width: 720px)').matches) setProofOpen(true)
    // 本文欄ができてから選ぶ
    const t = window.setTimeout(() => jumpToProof(s), 50)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofParam])
  const closeProof = useCallback(() => setProofOpen(false), [])

  // 保存していない編集があれば、移動する前に確かめる（usePieceSession.ts の useBlocker）
  const goTo = (id: ID | null) => {
    if (!id) return
    navigate(paths.piece(title.id, id))
  }

  /** コピーの見出し（編集中の見出し・話の題を使う）。幕は「第3話　題　第2幕」 */
  const pieceKind = piece.kind
  const storedLabel = piece.label
  const episodeId = episode.id
  const storedSubtitle = episode.subtitle
  const heading = useCallback(() => {
    const subtitle = session.display(pieceField(episodeId, 'subtitle'), storedSubtitle)
    if (pieceKind === 'act') return [pieceHeading('episode', label, subtitle), actName].filter(Boolean).join('　')
    return pieceHeading(
      pieceKind,
      pieceKind === 'episode' ? label : session.display(pieceField(episodeId, 'label'), storedLabel),
      subtitle,
    )
  }, [pieceKind, label, session, episodeId, storedLabel, storedSubtitle, actName])

  // 上部バーの「幕」メニュー: 幕に分ける（採用原稿のある話）／さらに分ける・次の幕とつなぐ・セパレート解除（幕）。
  // 項目は開いた時のデータで作る。保存していない編集があれば、操作の前に保存するか聞く
  const parentId = parent?.id ?? null
  const pieceId = piece.id
  const titleId = title.id
  const hasActive = active !== null
  const actMenu = useMemo(() => {
    if (pieceKind === 'special' || (pieceKind === 'episode' && !hasActive)) return null
    const guarded = (fn: () => unknown) => () => {
      void ensureSaved().then((ok) => (ok ? fn() : undefined))
    }
    // 控えのある別の幕を開く（つなぐ・解除の前に、その幕の保存されていない編集を確かめる時）
    const open = (id: ID) => navigate(paths.piece(titleId, id))
    // セパレート画面へは、原稿画面から開いた印を付けて移る（分けた後は履歴を戻り、同じ画面を二重に積まない）
    const toSeparate = () => navigate(paths.separate(titleId, pieceId), { state: { [SEPARATE_FROM_PIECE]: true } })
    return (): PopupMenuItem[] => {
      const d = getData()
      if (!parentId) {
        return [
          {
            label: '幕に分ける（セパレート）',
            icon: <SplitActsIcon />,
            hint: '採用原稿を区切って WEB 掲載用の幕にする（話数は増えません）',
            onSelect: guarded(toSeparate),
            testId: 'separate-button',
          },
        ]
      }
      const self = d.pieces[pieceId]
      const adopted = self ? activeVersion(d, self) !== null : false
      const items: PopupMenuItem[] = [
        {
          label: 'さらに分ける',
          icon: <ScissorsIcon />,
          disabled: !adopted,
          hint: adopted ? undefined : '採用稿のない幕は分けられません',
          onSelect: guarded(toSeparate),
          testId: 'separate-button',
        },
      ]
      const parentPiece = d.pieces[parentId]
      if (parentPiece && actNeighbors(d, parentPiece, pieceId).next) {
        const blocked = joinError(d, pieceId)
        items.push({
          label: '次の幕とつなぐ',
          icon: <JoinActsIcon />,
          disabled: blocked !== null,
          hint: blocked ?? undefined,
          onSelect: guarded(() => confirmJoin(pieceId, { open })),
          testId: 'join-next-button',
        })
      }
      const unsplitBlocked = unseparateError(d, parentId)
      items.push(
        {
          label: 'セパレート解除',
          icon: <UnsplitIcon />,
          disabled: unsplitBlocked !== null,
          hint: unsplitBlocked ?? '各幕の採用稿をつないで、1つの話に戻す',
          // 解除するとこの幕はなくなるので、話の画面へ移る
          onSelect: guarded(async () => {
            if (await confirmUnseparate(parentId, { open })) navigate(paths.piece(titleId, parentId), { replace: true })
          }),
          testId: 'unseparate-act-button',
        },
        {
          label: `幕の一覧（${label}）`,
          icon: <ActsIcon />,
          onSelect: () => navigate(paths.piece(titleId, parentId)),
          testId: 'open-folder',
        },
      )
      return items
    }
  }, [pieceKind, hasActive, parentId, pieceId, titleId, label, ensureSaved, navigate])

  // キーボードで押した「保存」「破棄」は、押した後に押せなく（無く）なってフォーカスが外れるので、最後に書いていた欄へ戻す
  // （指・マウスで押した時は戻さない。スマホでキーボードが開いてしまうので）
  const refocusAfter = (run: () => Promise<unknown>) => (e: { detail: number }) => {
    const byKeyboard = e.detail === 0
    void run().then(() => {
      if (!byKeyboard) return
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (!a || a === document.body || !a.isConnected || a.matches(':disabled')) {
          hub.getTarget()?.element()?.focus({ preventScroll: true })
        }
      })
    })
  }

  const crumbs: Crumb[] = [{ label: title.name || '無題のタイトル', to: paths.title(title.id) }]
  if (chapter) crumbs.push({ label: chapter.name || '（無題の章）', to: paths.chapter(title.id, chapter.id) })
  if (parent) {
    crumbs.push({ label, to: paths.piece(title.id, parent.id) })
    crumbs.push({ label: actName ?? '第?幕' })
  } else crumbs.push({ label })

  const api: WorkspaceApi = {
    piece,
    titleId: title.id,
    orientation,
    hub,
    select,
    ensureSaved,
    heading,
  }

  return (
    <div
      className={`pw-root${writing ? ' is-focus-mode' : ''}${dirty ? ' is-dirty' : ''}`}
      ref={rootRef}
      data-testid="piece-workspace"
    >
      <AppHeader
        crumbs={crumbs}
        actions={
          <>
            <SaveControls dirty={dirty} onSave={refocusAfter(save)} onDiscard={refocusAfter(discard)} />
            <Link
              to={paths.read(title.id)}
              className="icon-btn"
              aria-label="通し読み（採用原稿のみ）"
              title="通し読み（採用原稿のみ）"
            >
              <BookIcon />
            </Link>
          </>
        }
      />
      <PieceBar
        piece={piece}
        episode={episode}
        actLabel={actName}
        actMenu={actMenu}
        hub={hub}
        label={label}
        prev={neighbors.prev ? { id: neighbors.prev, label: pieceLabel(data, data.pieces[neighbors.prev], numbers) } : null}
        next={neighbors.next ? { id: neighbors.next, label: pieceLabel(data, data.pieces[neighbors.next], numbers) } : null}
        onNavigate={goTo}
        comparing={comparing}
        scrollSync={scrollSync}
        onScrollSyncChange={setScrollSync}
        showDiff={showDiff}
        onShowDiffChange={(v) => setPrefs({ showDiff: v })}
      />
      <SplitPane
        className="pw-split"
        orientation={orientation}
        ratio={splitRatio}
        onRatioChange={(r) => setPrefs({ splitRatio: r })}
        first={
          <ActivePane
            api={api}
            active={active}
            extra={
              openProof.length || proofOpen ? (
                <ProofChip count={openProof.length} open={proofOpen} onToggle={() => setProofOpen((v) => !v)} />
              ) : null
            }
          />
        }
        second={<VersionsPane api={api} active={active} selected={selected} showDiff={showDiff} />}
        firstLabel="採用原稿"
        secondLabel="推敲バージョン"
      />
      <SymbolBar hub={hub} dirty={dirty} onSave={() => void save()} />
      {proofOpen ? (
        <ProofPanel
          titleId={title.id}
          piece={piece}
          active={active}
          hub={hub}
          focusId={proofFocus}
          onClose={closeProof}
          jump={jumpToProof}
        />
      ) : null}
    </div>
  )
}

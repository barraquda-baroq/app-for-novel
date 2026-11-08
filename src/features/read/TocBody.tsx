// 話の一覧（目次）の中身。通し読みの目次と、原稿画面・幕の画面の「第n話」から開く話の一覧（PieceJump）で使う。
// 章の区切り・特殊ブロック・幕・「採用原稿なし」を、読む順に並べる。今の話・幕には aria-current="page" の印を付ける。
import { memo, type MouseEvent } from 'react'
import { NO_ACTIVE_MESSAGE } from '../../domain/readthrough'
import type { ID } from '../../domain/types'
import type { TocGroup } from './readLogic'
import './toc.css'

/** 項目を押した時（isAct は幕の項目） */
export type TocPick = (e: MouseEvent<HTMLAnchorElement>, target: { pieceId: ID; isAct: boolean }) => void

export interface TocBodyProps {
  groups: TocGroup[]
  /** 項目のリンクの行き先 */
  hrefOf: (pieceId: ID) => string
  onPick: TocPick
  /** 入れ物のクラス */
  className: string
  /** 縦書きのページ表示: 話・幕の最初のページの番号（出さない時は null） */
  pages?: ReadonlyMap<ID, number> | null
  /** 今開いている話・幕（印を付ける） */
  currentId?: ID | null
}

/** 目次の中身。開閉や表示の切り替えでは描き直さない（数百話あっても目次を開く・閉じるのを軽くする） */
export const TocBody = memo(function TocBody({ groups, hrefOf, onPick, className, pages, currentId }: TocBodyProps) {
  const pageOf = (id: ID) => {
    const n = pages?.get(id)
    return n === undefined ? null : (
      <span className="rt-toc-page" aria-label={`${n}ページ`} data-testid="toc-page">
        p.{n}
      </span>
    )
  }
  const current = (id: ID) => (currentId === id ? ('page' as const) : undefined)
  return (
    <div className={className}>
      {groups.map((g, gi) => (
        <div key={g.chapterId ?? `root-${gi}`} className="rt-toc-group">
          {g.name ? <p className="rt-toc-chapter">{g.name}</p> : null}
          <ol className="rt-toc-list">
            {g.items.map((b) => (
              <li key={b.pieceId}>
                <a
                  href={hrefOf(b.pieceId)}
                  className={`rt-toc-link${b.kind === 'special' ? ' is-special' : ''}`}
                  aria-current={current(b.pieceId)}
                  onClick={(e) => onPick(e, { pieceId: b.pieceId, isAct: false })}
                  data-testid="toc-link"
                >
                  <span className="rt-toc-label">{b.label}</span>
                  {b.subtitle.trim() ? <span className="rt-toc-subtitle">{b.subtitle.trim()}</span> : null}
                  {b.body === null && !b.acts ? (
                    <span className="rt-toc-missing" title={NO_ACTIVE_MESSAGE} data-testid="toc-missing">
                      採用原稿なし
                    </span>
                  ) : null}
                  {pageOf(b.pieceId)}
                </a>
                {b.acts ? (
                  <ol className="rt-toc-acts" aria-label={`${b.label}の幕`}>
                    {b.acts.map((a) => (
                      <li key={a.pieceId}>
                        <a
                          href={hrefOf(a.pieceId)}
                          className="rt-toc-link rt-toc-act"
                          aria-current={current(a.pieceId)}
                          onClick={(e) => onPick(e, { pieceId: a.pieceId, isAct: true })}
                          data-testid="toc-act-link"
                        >
                          <span className="rt-toc-label">{a.label}</span>
                          {a.body === null ? (
                            <span className="rt-toc-missing" title={NO_ACTIVE_MESSAGE} data-testid="toc-missing">
                              採用原稿なし
                            </span>
                          ) : null}
                          {pageOf(a.pieceId)}
                        </a>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
})

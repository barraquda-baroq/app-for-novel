// 欄ごとの検索窓（ペインのヘッダーと本文の間）と、ヘッダーの「検索」ボタン。動きは useFieldSearch.ts。
// 前へ・次へ・閉じるは、押しても検索窓のフォーカスを奪わない（記号バーと同じ。スマホのキーボードも閉じない）。
// 検索窓にいる間は、記号バーの記号・巻き戻しは本文に働かない（EditorHub.blurTarget。本文欄に戻ると働く）。
import type { KeyboardEvent } from 'react'
import { DownIcon, SearchIcon, UpIcon, XIcon } from '../../ui/icons'
import { keepFocus } from '../../ui/keys'
import { FIND_KEY_LABEL, isFindShortcut } from './fieldSearch'
import type { FieldSearch } from './useFieldSearch'

interface BarProps {
  search: FieldSearch
  /** 検索窓の名前（「採用原稿の検索」など） */
  label: string
  placeholder: string
}

export function FieldSearchBar({ search, label, placeholder }: BarProps) {
  const { slot } = search

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 変換を確定する Enter（Safari は isComposing を付けず keyCode 229 で届く）では探さない
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) search.prev()
      else search.next()
      return
    }
    if (e.key === 'Escape') {
      // 原稿画面のポップオーバー（表示の設定・「…」）が開いていれば、そちらを先に閉じる
      if (document.querySelector('[data-back-close="esc"]')) return
      e.preventDefault()
      e.stopPropagation()
      search.close({ toField: true })
      return
    }
    // 検索窓の中の Ctrl+F・⌘F はブラウザの検索を開かず、語を選び直す
    if (isFindShortcut(e)) {
      e.preventDefault()
      e.currentTarget.select()
    }
  }

  return (
    <div className="pw-search" role="search" aria-label={label} id={search.barId} data-testid={`${slot}-search`}>
      <SearchIcon className="icon pw-search-icon" />
      <input
        ref={search.inputRef}
        type="text"
        className="input pw-search-input"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value, (e.nativeEvent as InputEvent).isComposing)}
        onCompositionStart={search.onCompositionStart}
        onCompositionEnd={search.onCompositionEnd}
        onKeyDown={onKeyDown}
        onFocus={search.onInputFocus}
        enterKeyHint="search"
        maxLength={100}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={`${slot}-search-input`}
      />
      <span className="pw-search-count" role="status" aria-live="polite" data-testid={`${slot}-search-count`}>
        {search.status}
      </span>
      <span className="pw-search-nav" onPointerDown={keepFocus} onMouseDown={keepFocus}>
        <button
          type="button"
          className="icon-btn"
          onClick={search.prev}
          disabled={search.total === 0}
          aria-label="前を探す"
          title="前を探す（Shift+Enter）"
          data-testid={`${slot}-search-prev`}
        >
          <UpIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={search.next}
          disabled={search.total === 0}
          aria-label="次を探す"
          title="次を探す（Enter）"
          data-testid={`${slot}-search-next`}
        >
          <DownIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          // 検索窓で打っていた時（Esc と同じ）だけ本文欄へ戻して見つけた所を選ぶ。キーボードを閉じてから押した時は戻さない
          onClick={() => search.close({ toField: document.activeElement === search.inputRef.current })}
          aria-label="検索を閉じる"
          title="検索を閉じる（Esc）"
          data-testid={`${slot}-search-close`}
          // Android の「戻る」で押す（src/platform/nativeInit.ts の closeTopLayer）
          data-back-close="click"
        >
          <XIcon />
        </button>
      </span>
    </div>
  )
}

/** ペインのヘッダーの「検索」（開いていれば閉じる） */
export function SearchToggle({ search }: { search: FieldSearch }) {
  return (
    <button
      type="button"
      className={`btn pw-tbtn pw-search-toggle${search.open ? ' is-open' : ''}`}
      onClick={search.toggle}
      aria-expanded={search.open}
      aria-controls={search.open ? search.barId : undefined}
      title={`本文を検索（${FIND_KEY_LABEL}）`}
      data-testid={`${search.slot}-search-toggle`}
    >
      <SearchIcon />
      <span className="pw-tlabel">検索</span>
    </button>
  )
}

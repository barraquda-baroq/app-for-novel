// 相対比較に作品を追加する・作品の情報を直す（作品名は必須。著者・出版社・刊行年・ジャンル・PDF の置き場所・メモ）。
// 保存は［追加］［保存］を押した時（閉じると何も変えない）。
import { useId, useState } from 'react'
import { BENCH_LIMITS } from '../../domain/benchOps'
import type { BenchWork, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import './bench.css'

export interface BenchWorkDialogProps {
  /** 直す作品（null = 新しく足す） */
  work: BenchWork | null
  onClose: () => void
  /** 足した後（作品の id） */
  onAdded?: (id: ID) => void
}

export function BenchWorkDialog({ work, onClose, onAdded }: BenchWorkDialogProps) {
  const formId = useId()
  const [name, setName] = useState(work?.name ?? '')
  const [author, setAuthor] = useState(work?.author ?? '')
  const [publisher, setPublisher] = useState(work?.publisher ?? '')
  const [year, setYear] = useState(work?.year ?? '')
  const [genre, setGenre] = useState(work?.genre ?? '')
  const [pdfPlace, setPdfPlace] = useState(work?.pdfPlace ?? '')
  const [note, setNote] = useState(work?.note ?? '')
  const [tried, setTried] = useState(false)
  const missing = !name.trim()

  const save = () => {
    setTried(true)
    if (missing) return
    const input = { name, author, publisher, year, genre, pdfPlace, note }
    if (work) {
      if (attempt(() => (actions.updateBenchWork(work.id, input), true))) {
        notify('作品の情報を保存しました')
        onClose()
      }
      return
    }
    const id = attempt(() => actions.addBenchWork(input))
    if (!id) return
    notify(`「${name.trim()}」を相対比較に追加しました`)
    onClose()
    onAdded?.(id)
  }

  return (
    <Modal
      title={work ? '作品の情報を直す' : '作品を追加'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="bench-work-save">
            {work ? '保存' : '追加'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack bw-form"
        data-testid="bench-work-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        {!work ? (
          <p className="small muted bw-lead">
            比べるために読む既存の作品を相対比較に追加します。PDF は claude.ai のプロジェクトに置いたまま、Claude
            に分析してもらった内容だけをここに残します。
          </p>
        ) : null}
        <label className="field">
          <span>
            作品名<span className="bw-required">（必須）</span>
          </span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={BENCH_LIMITS.workName}
            placeholder="例：銀河の果ての図書館"
            aria-invalid={tried && missing ? true : undefined}
            aria-describedby={tried && missing ? `${formId}-name-error` : undefined}
            data-testid="bench-work-name"
          />
          {tried && missing ? (
            <span className="cl-error small" id={`${formId}-name-error`} role="alert">
              作品名を入れてください
            </span>
          ) : null}
        </label>
        <label className="field">
          <span>著者</span>
          <input
            className="input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            maxLength={BENCH_LIMITS.author}
            data-testid="bench-work-author"
          />
        </label>
        <div className="bw-form-row">
          <label className="field">
            <span>出版社（任意）</span>
            <input
              className="input"
              value={publisher}
              onChange={(e) => setPublisher(e.target.value)}
              maxLength={BENCH_LIMITS.publisher}
              data-testid="bench-work-publisher"
            />
          </label>
          <label className="field">
            <span>刊行年（任意）</span>
            <input
              className="input"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              maxLength={BENCH_LIMITS.year}
              inputMode="numeric"
              placeholder="例：2019"
              data-testid="bench-work-year"
            />
          </label>
          <label className="field">
            <span>ジャンル（任意）</span>
            <input
              className="input"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              maxLength={BENCH_LIMITS.genre}
              placeholder="例：SF"
              data-testid="bench-work-genre"
            />
          </label>
        </div>
        <label className="field">
          <span>PDF の置き場所</span>
          <input
            className="input"
            value={pdfPlace}
            onChange={(e) => setPdfPlace(e.target.value)}
            maxLength={BENCH_LIMITS.pdfPlace}
            placeholder="例：claude.ai のプロジェクト「相対比較」"
            data-testid="bench-work-pdf"
          />
        </label>
        <label className="field">
          <span>メモ</span>
          <textarea
            className="textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="なぜこの作品を比べるか、読んだ感想など"
            data-testid="bench-work-note"
          />
        </label>
      </form>
    </Modal>
  )
}

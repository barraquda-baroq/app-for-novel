// 資料の棚に資料を追加する・資料の情報を直す（資料名は必須。著者・出版社・刊行年・タグ・PDF の置き場所・メモ）。
// タグは作者が自分で付ける（いくつでも。すべての資料で使っているタグを候補に出す。そろえると、棚のタグのチップで絞りやすい）。
// 保存は［追加］［保存］を押した時（閉じると何も変えない）。相対比較の BenchWorkDialog と同じ作り。
import { useId, useRef, useState } from 'react'
import { MATERIAL_LIMITS } from '../../domain/materialOps'
import type { ID, Material } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import { materialTags } from './materialLogic'
import { useTagsInUse } from './MaterialTagDialogs'
import { TagEditor } from './TagEditor'
import './materials.css'

export interface MaterialDialogProps {
  /** 直す資料（null = 新しく足す） */
  material: Material | null
  onClose: () => void
  /** 足した後（資料の id） */
  onAdded?: (id: ID) => void
}

export function MaterialDialog({ material, onClose, onAdded }: MaterialDialogProps) {
  const formId = useId()
  const inUse = useTagsInUse()
  const [name, setName] = useState(material?.name ?? '')
  const [author, setAuthor] = useState(material?.author ?? '')
  const [publisher, setPublisher] = useState(material?.publisher ?? '')
  const [year, setYear] = useState(material?.year ?? '')
  const [tags, setTags] = useState<string[]>(() => (material ? materialTags(material) : []))
  const flushTags = useRef<(() => string[] | null) | null>(null)
  const [pdfPlace, setPdfPlace] = useState(material?.pdfPlace ?? '')
  const [note, setNote] = useState(material?.note ?? '')
  const [tried, setTried] = useState(false)
  const missing = !name.trim()

  const save = () => {
    setTried(true)
    if (missing) return
    // 打ちかけのタグを足せない時（20字を超えるなど）は保存しない（理由はタグの欄に出ている）
    const nextTags = flushTags.current ? flushTags.current() : tags
    if (!nextTags) return
    const input = { name, author, publisher, year, tags: nextTags, pdfPlace, note }
    if (material) {
      if (attempt(() => (actions.updateMaterial(material.id, input), true))) {
        notify('資料の情報を保存しました')
        onClose()
      }
      return
    }
    const id = attempt(() => actions.addMaterial(input))
    if (!id) return
    notify(`「${name.trim()}」を資料の棚に追加しました`)
    onClose()
    onAdded?.(id)
  }

  return (
    <Modal
      title={material ? '資料の情報を直す' : '資料を追加'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="material-save">
            {material ? '保存' : '追加'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack mt-form"
        data-testid="material-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        {!material ? (
          <p className="small muted mt-lead">
            創作のために読む資料（主に書籍）を資料の棚に追加します。PDF は claude.ai のプロジェクトに置いたまま、Claude
            に読んでもらった要約・創作に役立つ知識・描写に使える部分・サンプルシーンだけをここに残します。
          </p>
        ) : null}
        <label className="field">
          <span>
            資料名<span className="mt-required">（必須）</span>
          </span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MATERIAL_LIMITS.materialName}
            placeholder="例：江戸の町と暮らし"
            aria-invalid={tried && missing ? true : undefined}
            aria-describedby={tried && missing ? `${formId}-name-error` : undefined}
            data-testid="material-name"
          />
          {tried && missing ? (
            <span className="cl-error small" id={`${formId}-name-error`} role="alert">
              資料名を入れてください
            </span>
          ) : null}
        </label>
        <label className="field">
          <span>著者</span>
          <input
            className="input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            maxLength={MATERIAL_LIMITS.author}
            data-testid="material-author"
          />
        </label>
        <div className="mt-form-row">
          <label className="field">
            <span>出版社（任意）</span>
            <input
              className="input"
              value={publisher}
              onChange={(e) => setPublisher(e.target.value)}
              maxLength={MATERIAL_LIMITS.publisher}
              data-testid="material-publisher"
            />
          </label>
          <label className="field">
            <span>刊行年（任意）</span>
            <input
              className="input"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              maxLength={MATERIAL_LIMITS.year}
              inputMode="numeric"
              placeholder="例：2019"
              data-testid="material-year"
            />
          </label>
        </div>
        <TagEditor tags={tags} onChange={setTags} inUse={inUse} flushRef={flushTags} />
        <label className="field">
          <span>PDF の置き場所</span>
          <input
            className="input"
            value={pdfPlace}
            onChange={(e) => setPdfPlace(e.target.value)}
            maxLength={MATERIAL_LIMITS.pdfPlace}
            placeholder="例：claude.ai のプロジェクト「資料」"
            data-testid="material-pdf"
          />
        </label>
        <label className="field">
          <span>メモ</span>
          <textarea
            className="textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="何のために読むか、どの作品で使うかなど"
            data-testid="material-memo"
          />
        </label>
      </form>
    </Modal>
  )
}

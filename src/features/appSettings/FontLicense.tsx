// 「書体のライセンス」: アプリに同梱した数字の書体（Roboto Mono。src/fonts/）の著作権の表示と、ライセンス（SIL Open Font License 1.1）の全文。
// 全文はアプリの中のダイアログで読む（iPhone / Android のアプリでは、別のページに移ると戻れないため）。全文は開いた時に読み込む。
import { useId, useRef, useState } from 'react'
import { Modal } from '../../ui/Modal'

export const FONT_CREDIT = 'Roboto Mono — Copyright 2015 The Roboto Mono Project Authors（SIL Open Font License 1.1）'

/** ライセンスの全文（別のチャンク。オフラインでも読める） */
async function loadLicense(): Promise<string> {
  const mod = await import('../../fonts/roboto-mono/OFL.txt?raw')
  return mod.default
}

/** 段落の始めの見出しの行（PREAMBLE・PERMISSION & CONDITIONS など。大文字だけ） */
const HEADING = /^[A-Z][A-Z &]*$/

/**
 * 画面で読むための形にする（同梱した OFL.txt はそのまま）。決まった幅で折り返した行を段落ごとに1行につなぎ（間は空白）、
 * 段落の間の空行は残す。段落の始めの見出しの行はつながない。「-----」だけの行は空行にする。
 */
function licenseForDisplay(raw: string): string {
  const out: string[] = []
  let joinable = false
  for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
    if (line === '' || /^-+$/.test(line)) {
      out.push('')
      joinable = false
    } else if (joinable) {
      out[out.length - 1] += ` ${line}`
    } else {
      out.push(line)
      joinable = !HEADING.test(line)
    }
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function FontLicense() {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  // 読み込めなかった時は全文と分けて持ち、次に「全文を見る」を押した時に読み込み直す
  const [failed, setFailed] = useState(false)
  const loading = useRef(false)
  const show = () => {
    setOpen(true)
    if (text !== null || loading.current) return
    loading.current = true
    setFailed(false)
    loadLicense()
      .then(
        (raw) => setText(licenseForDisplay(raw)),
        () => setFailed(true),
      )
      .finally(() => {
        loading.current = false
      })
  }
  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="font-license">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>書体のライセンス</h2>
      </div>
      <p className="aset-note">
        件数や日付などの数字に使う書体です。
        <br />
        <span data-testid="font-credit">{FONT_CREDIT}</span>
      </p>
      <div className="aset-actions">
        <button type="button" className="btn btn-sm" onClick={show} data-testid="font-license-open">
          全文を見る
        </button>
      </div>
      {open ? (
        <Modal
          title="Roboto Mono のライセンス"
          wide
          onClose={() => setOpen(false)}
          footer={
            <button type="button" className="btn" onClick={() => setOpen(false)} data-testid="font-license-close">
              閉じる
            </button>
          }
        >
          {text !== null ? (
            <pre className="aset-license" data-testid="font-license-text">
              {text}
            </pre>
          ) : failed ? (
            <p className="aset-note aset-warn" role="alert" data-testid="font-license-error">
              ライセンスの全文を読み込めませんでした。通信できる所で、ページを読み込み直してから開いてください。
            </p>
          ) : (
            <p className="aset-note" data-testid="font-license-loading">
              読み込んでいます…
            </p>
          )}
        </Modal>
      ) : null}
    </section>
  )
}

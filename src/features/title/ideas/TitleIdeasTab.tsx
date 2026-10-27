// タイトル画面のアイデアタブ: このタイトルの仕切りだけを表示する（ホームのアイデア領域と同じ部品）。
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ideaSections } from '../../../domain/entityOps'
import type { ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { useData } from '../../../store/appStore'
import { ChevronRightIcon } from '../../../ui/icons'
import { sectionDisplayName } from '../../ideas/ideaLogic'
import { IdeaSectionView } from '../../ideas/IdeaSectionView'
import { QuickCapture } from '../../ideas/QuickCapture'
import './titleIdeas.css'

export function TitleIdeasTab({ titleId }: { titleId: ID }) {
  const data = useData()
  const section = useMemo(() => ideaSections(data).find((s) => s.titleId === titleId), [data, titleId])
  if (!section) return null
  const name = sectionDisplayName(section)

  return (
    <div className="tideas" data-testid="title-ideas">
      <div className="tideas-head">
        <p className="tideas-hint">
          このタイトルのアイデアです。各アイデアの「移動」から、ほかのタイトルや「どのタイトルにも属さない」へ移せます。
        </p>
        <Link
          to={{ pathname: paths.home(), search: `?view=ideas&focus=${encodeURIComponent(titleId)}` }}
          className="btn btn-sm tideas-all"
          data-testid="all-ideas-link"
        >
          すべてのアイデアを見る
          <ChevronRightIcon />
        </Link>
      </div>

      <QuickCapture fixedTitleId={titleId} fixedName={name} draftKey={`title:${titleId}`} />

      <IdeaSectionView section={section} heading="このタイトルのアイデア" />
    </div>
  )
}

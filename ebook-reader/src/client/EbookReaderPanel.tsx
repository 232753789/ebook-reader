import type { EbookReaderPanelProps } from './contract.ts'
import { LibraryPanel } from './LibraryPanel.tsx'
import { ReaderView } from './ReaderView.tsx'
import css from './EbookReaderPanel.module.css'

/**
 * The panel selected by the sidebar entry. The Desktop sidebar has no tab region, so the library
 * list the Web profile keeps in its sidebar tab stays beside the reader: any book opens from it
 * while another is open, as in the Web profile.
 */
export function EbookReaderPanel(props: EbookReaderPanelProps) {
  return (
    <div className={css.layout}>
      <div className={css.library}>
        <LibraryPanel {...props} />
      </div>
      <div className={css.reader}>
        <ReaderView {...props} />
      </div>
    </div>
  )
}

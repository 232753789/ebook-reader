import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** The compact icon shown in the Desktop sidebar panel list. */
export function LibraryPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 4.5h4l1.2 1.4h7.8v6.2a1.4 1.4 0 0 1-1.4 1.4H2.9a1.4 1.4 0 0 1-1.4-1.4V4.5Z" fill="currentColor" />
      <path d="M1.5 4.5V3.4A1.4 1.4 0 0 1 2.9 2h3.2l1.2 1.4h3.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

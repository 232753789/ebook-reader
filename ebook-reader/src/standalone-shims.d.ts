declare module '@deepseek-ai/cordis' { export type Context = any }
declare module '@deepseek-ai/dsh-invariants' { export type InvariantInstaller = any }
declare module '@deepseek-ai/dsh-brand' { export type Branded<T> = T & { readonly __brand: T } }
declare module '@deepseek-ai/schemastery' { const z: any; namespace z { type z<T> = any }; export default z }
declare module '@deepseek-ai/dsh-home-paths' { export const dshHomePath: any; export const expandHomePath: any }
declare module '@deepseek-ai/dsh-timeout' { export const MAX_TIMER_DELAY_MS: number; export const deadline: any }
declare module '@deepseek-ai/dsh-atomic-write' { export const writeFileAtomic: any }
declare module '@deepseek-ai/dsh-host-webserver' {}
declare module '@deepseek-ai/dsh-subprocess' {}
declare module '@deepseek-ai/dsh-client-store' {
  export type ClientContext = any
  export type EngineStoreHandle<T = any, U = any> = any
  export const defineStore: any
}
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type TranslateNS<T = any> = any; export type HostObservable<T = any> = any; export type InjectFace<T = any> = any
  export type PropsLocale<T = any> = any; export type PropsRuntime<T = any> = any; export type PropsStore<T = any> = any
}
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const IconLoadingOutline16: any; export const IconRefreshOutline16: any; export const IconSearchOutline16: any
  export const IconChevronLeftOutline14: any; export const IconChevronRightOutline14: any; export const IconPanelLeftOutline16: any
  export const IconPauseOutline16: any; export const IconPlayOutline16: any; export const IconStopFill16: any
  export const Tooltip: any
}

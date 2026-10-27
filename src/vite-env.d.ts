/// <reference types="vite/client" />

declare module 'virtual:content' {
  import type { ContentIndex } from '@/content/types'
  const index: ContentIndex
  export default index
}

declare module 'virtual:search-docs' {
  import type { SearchDoc } from '@/content/types'
  const docs: SearchDoc[]
  export default docs
}

declare module '*.yaml' {
  const data: unknown
  export default data
}

declare module '*.mdx' {
  import type { MDXProps } from 'mdx/types'
  export const frontmatter: Record<string, unknown>
  export default function MDXContent(props: MDXProps): import('react').JSX.Element
}

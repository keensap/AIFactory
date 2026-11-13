import { Children, isValidElement, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { CheckIcon, CopyIcon } from './Icons.tsx'
import { copyText } from '../lib/clipboard.ts'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

export interface MarkdownProps {
  children: string
  onCopy?: (message: string) => void
}

export function Markdown({ children, onCopy }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children: preChildren }) => <PreBlock onCopy={onCopy}>{preChildren}</PreBlock>,
          code: ({ className, children: codeChildren }) => {
            if (typeof className === 'string' && className.includes('language-')) {
              // Fenced code is rendered by PreBlock; keep the raw element shape.
              return <code className={className}>{codeChildren}</code>
            }
            return <code className="inline-code">{codeChildren}</code>
          },
          a: ({ href, children: linkChildren }) => {
            const external = href !== undefined && /^https?:\/\//.test(href)
            return (
              <a
                href={href}
                {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
              >
                {linkChildren}
              </a>
            )
          },
          img: ({ src, alt }) => (
            <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
          ),
          input: ({ checked }) => <input type="checkbox" checked={checked} readOnly disabled />,
          table: ({ children: tableChildren }) => (
            <div className="markdown-table-wrap">
              <table>{tableChildren}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function PreBlock({ children, onCopy }: { children: ReactNode; onCopy?: (message: string) => void }) {
  const child = Children.toArray(children).find(isValidElement) as
    | ReactElement<{ className?: string; children?: ReactNode }>
    | undefined
  if (child === undefined) return <pre>{children}</pre>
  return (
    <CodeBlock className={child.props.className} onCopy={onCopy}>
      {child.props.children}
    </CodeBlock>
  )
}

function CodeBlock({
  className,
  children,
  onCopy,
}: {
  className?: string
  children: ReactNode
  onCopy?: (message: string) => void
}) {
  const code = flatten(children).replace(/\n$/, '')
  const language = /language-([\w-]+)/.exec(className ?? '')?.[1]?.toLowerCase()
  const html = useMemo(() => highlight(code, language), [code, language])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    const ok = await copyText(code)
    if (ok) {
      setCopied(true)
      onCopy?.('Code copied')
    } else {
      onCopy?.('Could not copy code')
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{language ?? 'code'}</span>
        <button
          type="button"
          className="code-copy"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code
          className={`hljs${language === undefined ? '' : ` language-${language}`}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  )
}

function highlight(code: string, language: string | undefined): string {
  if (language !== undefined && hljs.getLanguage(language) !== undefined) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      return escapeHtml(code)
    }
  }
  return escapeHtml(code)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function flatten(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return flatten(node.props.children)
  return ''
}

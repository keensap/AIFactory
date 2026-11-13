import { useId } from 'react'

export interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
}

function base(size: number, className: string | undefined, strokeWidth: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }
}

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2f66e8" />
          <stop offset="0.55" stopColor="#3f82f4" />
          <stop offset="1" stopColor="#37c2e0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}-g)`} />
      <path
        d="M20 45 31.8 19h3.9L47 45h-8.1l-1.9-4.9H29.4L27.5 45H20Zm11.6-11.3h4.6l-2.2-6.3-2.4 6.3Z"
        fill="#fff"
      />
      <circle cx="47.5" cy="17.5" r="4.5" fill="#fff" fillOpacity="0.82" />
    </svg>
  )
}

export function PlusIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function SearchIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.2 4.2" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function PanelLeftIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
      <path d="M5.5 8h1" />
    </svg>
  )
}

export function SettingsIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.95 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.95a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 10 3.04V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8.95a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.02Z" />
    </svg>
  )
}

export function SunIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
    </svg>
  )
}

export function MoonIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M20.5 14.4A8.5 8.5 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z" />
    </svg>
  )
}

export function MonitorIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

export function SendIcon({ size = 18, className, strokeWidth = 1.9 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  )
}

export function StopIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  )
}

export function PaperclipIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m20.5 11.5-8.2 8.2a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
    </svg>
  )
}

export function SparklesIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />
      <path d="M18.5 15.5 19.3 18l2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8.8-2.5Z" />
    </svg>
  )
}

export function FolderIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z" />
    </svg>
  )
}

export function FolderPlusIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  )
}

export function MoreIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </svg>
  )
}

export function TrashIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M4 7h16M9.5 7V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 11v5.5M14 11v5.5" />
    </svg>
  )
}

export function PencilIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m14.5 5.5 4 4M4 20l1-4.2L16.4 4.4a2.3 2.3 0 0 1 3.2 0 2.3 2.3 0 0 1 0 3.2L8.2 19 4 20Z" />
    </svg>
  )
}

export function CopyIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.4" />
      <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
    </svg>
  )
}

export function CheckIcon({ size = 18, className, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m5 12.5 4.4 4.4L19 6.8" />
    </svg>
  )
}

export function RefreshIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

export function CloseIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

export function MessageIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M20.5 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3.5 20.5l1.1-4.3A8.5 8.5 0 1 1 20.5 12Z" />
    </svg>
  )
}

export function CodeIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14" />
    </svg>
  )
}

export function BranchIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="17.5" cy="8" r="2.5" />
      <path d="M6.5 8v8M17.5 10.5c0 3.2-2.4 5.5-5.5 5.5h-2" />
    </svg>
  )
}

export function UsersIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="9.5" cy="8.5" r="3.3" />
      <path d="M3.5 19.5c0-3 2.7-5.2 6-5.2s6 2.2 6 5.2" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 6.1M17.5 14.7c2 .6 3.5 2.3 3.5 4.5" />
    </svg>
  )
}

export function AlertIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M12 3.8 21 20H3L12 3.8Z" />
      <path d="M12 9.5v4.5M12 17.2v.1" />
    </svg>
  )
}

export function WifiIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M4 8.5a13 13 0 0 1 16 0M6.8 12a9 9 0 0 1 10.4 0M9.6 15.4a4.6 4.6 0 0 1 4.8 0" />
      <path d="M12 19h.01" />
    </svg>
  )
}

export function WifiOffIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m3 3 18 18" />
      <path d="M8.6 8.7a13 13 0 0 1 11.4-.2M6.7 12.2a9 9 0 0 1 4.4-1.4M9.7 15.6a4.6 4.6 0 0 1 4.5.1" />
      <path d="M12 19h.01" />
    </svg>
  )
}

export function ArrowDownIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  )
}

export function ClockIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </svg>
  )
}

export function LayersIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m4 12 8 4.2 8-4.2M4 16.5l8 4.2 8-4.2" />
    </svg>
  )
}

export function CommandIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H9V6.5ZM9 17.5A2.5 2.5 0 1 1 6.5 15H9v2.5ZM15 6.5A2.5 2.5 0 1 1 17.5 9H15V6.5ZM15 17.5a2.5 2.5 0 1 0 2.5-2.5H15v2.5ZM9 9h6v6H9V9Z" />
    </svg>
  )
}

export function PanelRightIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M15 4v16" />
      <path d="M17.5 8h.5" />
    </svg>
  )
}

export function InfoIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2M12 7.8v.1" />
    </svg>
  )
}

export function ArrowUpRightIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  )
}

export function MailIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  )
}

export function ArrowLeftIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}

export function HomeIcon({ size = 18, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function ListIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  )
}

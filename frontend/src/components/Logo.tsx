export function Logo({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--brand)" />
        <path d="M9 22V10h3v9.5h5V22H9Zm9.5-7.5h4.5v7.5h-4.5z" fill="#fff" />
        <path d="M18.5 10H23v3h-4.5z" fill="#fff" opacity=".6" />
      </svg>
      <span className="text-[17px] font-semibold tracking-tight">Ledgerwise</span>
    </div>
  )
}

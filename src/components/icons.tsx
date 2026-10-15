type P = { className?: string };

export function LockIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon-lock'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function WarnIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon-lock'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4 3 20h18L12 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="17.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function PaperclipIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 11.5 12 19.5a4.6 4.6 0 0 1-6.5-6.5l8-8a3.2 3.2 0 0 1 4.6 4.6l-7.9 7.9a1.8 1.8 0 0 1-2.6-2.6l7.2-7.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ImageIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m5 17 4.5-5 3.5 3.5L17 12l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9" cy="9.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function FileIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function DownloadIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function BellIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 16V10a6 6 0 1 1 12 0v6l1.5 2.5H4.5L6 16Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 21h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ className }: P) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

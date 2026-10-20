export function RemoveSavedItemButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="saved-item-remove" aria-label={label} title={label} onClick={onClick}>
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  </button>;
}

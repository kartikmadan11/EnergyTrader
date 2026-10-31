/** The EnergyTrader mark, matching app/icon.svg. */
export default function BrandMark({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#006DAE" />
      <path d="M18.5 5 9 18h6l-1.5 9L23 14h-6l1.5-9Z" fill="#fff" />
    </svg>
  );
}

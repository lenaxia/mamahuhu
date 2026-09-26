export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className = "",
}: {
  options: { value: T; label: React.ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div className={`inline-flex rounded-xl bg-neutral-200/70 dark:bg-neutral-800 p-0.5 ${className}`} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`${pad} rounded-[0.6rem] font-medium transition-colors ${
            value === o.value
              ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
              : "text-neutral-500 dark:text-neutral-400"
          } ${o.disabled ? "opacity-40" : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

"use client";
// Manager-side building blocks. Values come from the v4 handoff (radii, borders, sizes, copy patterns).
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useDialog } from "../ui/useDialog";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export const ICON = { strokeWidth: 2.75, "aria-hidden": true } as const;

type Variant = "primary" | "outline" | "dark" | "charcoal";
const VARIANT: Record<Variant, string> = {
  primary: "sg-primary border-0 bg-indigo text-white",
  outline: "sg-outline border-2 border-indigo bg-transparent text-indigo",
  dark: "sg-outline border-2 border-charcoal bg-transparent text-charcoal",
  charcoal: "border-0 bg-charcoal text-white",
};

export function Button({
  variant = "primary", className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx("min-h-[52px] rounded-full px-[22px] text-base font-bold disabled:opacity-45", VARIANT[variant], className)}
    />
  );
}

/** Toggle pill used for segmented controls, tool chips and filters (`pill()` in the prototype). */
export function Pill({ on, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { on: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      {...rest}
      className={cx(
        "rounded-full border-2 font-bold",
        on ? "border-indigo bg-indigo text-white" : "border-control bg-ivory text-charcoal",
        className,
      )}
    />
  );
}

export const BackLink = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className="self-start border-0 bg-transparent py-2 text-[15px] font-bold text-indigo">
    ‹ {children}
  </button>
);

export function PageHeader({ title, sub, back }: { title: ReactNode; sub?: ReactNode; back?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1 pt-2">
      {back}
      <h1 className="m-0 font-display text-[28px] font-normal text-indigo">{title}</h1>
      {sub ? <p className="m-0 text-[15px] text-muted">{sub}</p> : null}
    </header>
  );
}

export const Card = ({ className, children, ...rest }: React.HTMLAttributes<HTMLElement> & { as?: "section" }) => (
  <section {...rest} className={cx("rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]", className)}>
    {children}
  </section>
);

export const H2 = ({ id, children, className }: { id?: string; children: ReactNode; className?: string }) => (
  <h2 id={id} className={cx("m-0 font-display text-xl font-normal text-indigo", className)}>
    {children}
  </h2>
);

export const DemoTag = ({ tone = "tint" }: { tone?: "tint" | "ivory" }) => (
  <span className={cx("self-start rounded-full px-3 py-1 text-[13px] font-semibold", tone === "tint" ? "bg-tint" : "bg-ivory")}>
    Demo action · local demo state, not saved to a server
  </span>
);

export const controlClass =
  "min-h-[52px] w-full min-w-0 rounded-full border-2 border-control bg-ivory px-[18px] text-base font-normal text-charcoal";

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[15px] font-semibold">
      {label}
      {children}
    </label>
  );
}

export function Select({ options, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { options: { v: string; l: string }[] }) {
  return (
    <select {...rest} className={cx(controlClass, className)}>
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
}

export function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className={cx("flex min-h-[52px] items-start gap-3 rounded-[20px] p-3.5 text-base font-bold", checked ? "bg-tint" : "bg-lavender")}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="m-0 size-6 flex-none accent-indigo"
      />
      {children}
    </label>
  );
}

/** Checklist rows: mark + "Done:"/"Needs correction:" text + fix sentence, so state never relies on color alone. */
export function Checklist({ items }: { items: { ok: boolean; label: string; fix: string }[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {items.map((c) => (
        <li key={c.label} className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className={cx(
              "flex size-[26px] flex-none items-center justify-center rounded-full text-sm font-extrabold",
              c.ok ? "bg-indigo text-white" : "bg-warn text-charcoal",
            )}
          >
            {c.ok ? "✓" : "✕"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] leading-[1.35] font-bold">
              {c.ok ? "Done" : "Needs correction"}: {c.label}
            </span>
            {!c.ok && <span className="mt-0.5 block text-sm leading-[1.4] text-muted">{c.fix}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Bottom sheet: backdrop rgba(37,35,49,.45), ivory, radius 32 32 0 0, 44×5 handle. */
export function Sheet({
  labelledBy, onClose, children, maxH = "86%",
}: { labelledBy: string; onClose: () => void; children: ReactNode; maxH?: string }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div className="absolute inset-0 z-40">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-[rgba(37,35,49,.45)]" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={{ maxHeight: maxH }}
        className="absolute inset-x-0 bottom-0 flex flex-col gap-3.5 overflow-y-auto rounded-t-[32px] bg-ivory px-5 pt-3 pb-8"
      >
        <span aria-hidden="true" className="h-[5px] w-11 self-center rounded-full bg-mapline" />
        {children}
      </div>
    </div>
  );
}

/** Centered confirmation (role=alertdialog), radius 32, shadow 0 12px 32px. */
export function AlertDialog({
  labelledBy, describedBy, onClose, children,
}: { labelledBy: string; describedBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(37,35,49,.55)] p-5">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="flex w-full flex-col gap-3 rounded-[32px] bg-ivory p-6 shadow-[0_12px_32px_rgba(37,35,49,.3)]"
      >
        {children}
      </div>
    </div>
  );
}

/** Round placeholder where a product or evidence photo goes (no photos are stored in the demo). */
export function PhotoSlot({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("flex flex-none items-center justify-center bg-tint text-center text-[11px] font-bold text-muted", className)}
    >
      {label}
    </span>
  );
}

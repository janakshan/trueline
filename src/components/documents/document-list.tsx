"use client";

import Link from "next/link";
import type { DocumentSummary } from "@/lib/documents/serialize";
import { cn } from "@/lib/cn";
import { formatAmount, formatDate, formatRelative } from "@/lib/format";
import { FlagCount, StatusChip } from "./status-chip";

/**
 * Table on desktop, cards on mobile — the central responsive decision from
 * ui-plan.md. A horizontally scrolling table on a 375px screen is the fastest
 * way to look unfinished, so below `md` the same data is re-laid-out rather
 * than shrunk.
 */

interface Props {
  items: DocumentSummary[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      className="size-4 cursor-pointer rounded border-border-strong accent-[var(--color-primary)]"
    />
  );
}

export function DocumentList({ items, selected, onToggle, onToggleAll }: Props) {
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  return (
    <>
      {/* ---------- desktop table ---------- */}
      <table className="hidden w-full border-collapse md:table">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="w-10 px-4 py-2.5">
              <Checkbox checked={allSelected} onChange={onToggleAll} label="Select all documents" />
            </th>
            <th className="px-3 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted">
              Vendor
            </th>
            <th className="px-3 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted">
              Issued
            </th>
            <th className="px-3 py-2.5 text-right text-2xs font-medium uppercase tracking-wider text-muted">
              Total
            </th>
            <th className="px-3 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted">
              Status
            </th>
            <th className="w-16 px-3 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted">
              Flags
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className={cn(
                "group border-b border-border transition-colors last:border-0",
                selected.has(item.id) ? "bg-surface-hover" : "hover:bg-surface-hover",
              )}
            >
              <td className="px-4 py-3 align-middle">
                <Checkbox
                  checked={selected.has(item.id)}
                  onChange={() => onToggle(item.id)}
                  label={`Select ${item.filename}`}
                />
              </td>
              <td className="max-w-0 px-3 py-3">
                <Link href={`/documents/${item.id}`} className="block">
                  <span className="block truncate font-medium text-ink">
                    {item.vendorName ?? <span className="text-subtle">Not extracted yet</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-subtle">{item.filename}</span>
                </Link>
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-muted tabular">
                {formatDate(item.issueDate)}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right font-medium tabular-mono">
                {item.totalAmount === null ? (
                  <span className="text-subtle">—</span>
                ) : (
                  <>
                    <span className="text-xs text-subtle">{item.currency} </span>
                    {formatAmount(item.totalAmount)}
                  </>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-3">
                <StatusChip status={item.status} />
              </td>
              <td className="px-3 py-3">
                <FlagCount count={item.flagCount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---------- mobile cards ---------- */}
      <ul className="divide-y divide-border md:hidden">
        {items.map((item) => (
          <li key={item.id} className="relative">
            <div className="absolute left-4 top-4 z-10">
              <Checkbox
                checked={selected.has(item.id)}
                onChange={() => onToggle(item.id)}
                label={`Select ${item.filename}`}
              />
            </div>
            <Link
              href={`/documents/${item.id}`}
              className={cn(
                "block py-3.5 pl-11 pr-4 transition-colors",
                selected.has(item.id) && "bg-surface-hover",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {item.vendorName ?? <span className="text-subtle">Not extracted yet</span>}
                </span>
                <span className="shrink-0 font-medium tabular-mono">
                  {item.totalAmount === null ? (
                    <span className="text-subtle">—</span>
                  ) : (
                    `${item.currency ?? ""} ${formatAmount(item.totalAmount)}`
                  )}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-subtle">{item.filename}</div>
              <div className="mt-2 flex items-center gap-2">
                <StatusChip status={item.status} />
                <FlagCount count={item.flagCount} />
                <span className="ml-auto text-2xs text-subtle">
                  {formatRelative(item.createdAt)}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

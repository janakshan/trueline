import { Skeleton } from "@/components/ui/feedback";

export default function ReviewLoading() {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-56 max-w-[40%]" />
        <Skeleton className="ml-auto h-6 w-24 rounded-full" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden shrink-0 basis-[44%] p-4 lg:block">
          <Skeleton className="h-full w-full rounded-[var(--radius-panel)]" />
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-hidden p-4">
          {[4, 6].map((count) => (
            <div key={count} className="space-y-3">
              <Skeleton className="h-3 w-24" />
              <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: count }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

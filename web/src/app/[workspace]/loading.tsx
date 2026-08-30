export default function WorkspaceLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8"
    >
      <div className="flex motion-safe:animate-pulse flex-col gap-3">
        <div className="bg-surface-tertiary h-7 w-48 rounded-md" />
        <div className="bg-surface-tertiary h-4 w-full max-w-xl rounded-md" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="border-border bg-surface-card flex h-32 motion-safe:animate-pulse flex-col gap-3 rounded-lg border p-4"
          >
            <div className="bg-surface-tertiary h-4 w-24 rounded-md" />
            <div className="bg-surface-tertiary h-8 w-16 rounded-md" />
            <div className="bg-surface-tertiary mt-auto h-3 w-32 rounded-md" />
          </div>
        ))}
      </div>
      <div className="border-border bg-surface-card flex motion-safe:animate-pulse flex-col gap-4 rounded-lg border p-4">
        <div className="bg-surface-tertiary h-5 w-36 rounded-md" />
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="bg-surface-tertiary h-10 w-full rounded-md"
          />
        ))}
      </div>
      <span className="sr-only">Loading page</span>
    </div>
  );
}

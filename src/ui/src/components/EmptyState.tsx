export function EmptyState({ message, tone = "neutral" }: { message: string; tone?: "neutral" | "danger" | "success" }) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-text-secondary";
  return (
    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-soft py-8 text-center">
      <p className={`px-4 text-sm ${color}`}>{message}</p>
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import type { DeliveryStatus, DestinationStatus } from "@/lib/outputs-db";

const LABELS: Record<DeliveryStatus | DestinationStatus, string> = {
  confirmed: "Confirmed",
  partial: "Partial",
  failed: "Failed",
  unobserved: "Unobserved",
  undeclared: "Undeclared",
};

const VARIANTS: Record<
  DeliveryStatus | DestinationStatus,
  "green" | "yellow" | "red" | "gray"
> = {
  confirmed: "green",
  partial: "yellow",
  failed: "red",
  unobserved: "gray",
  undeclared: "gray",
};

export function DeliveryStatusBadge({
  status,
}: {
  status: DeliveryStatus | DestinationStatus;
}) {
  return (
    <Badge size="small" variant={VARIANTS[status]}>
      {LABELS[status]}
    </Badge>
  );
}

import { severityLabel } from "../../domain/vocabulary";
import { Badge } from "../Badge";
import { Banner } from "../Banner";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { TyreIcon } from "../icons/Tyre";
import { SeverityBadge } from "../SeverityBadge";
import { Skeleton } from "../Skeleton";
import { StatusBadge } from "../StatusBadge";
import { SyncStatus } from "../SyncStatus";
import type { GallerySection } from "./types";

// Rule 5: the condition words are the caller's; these are capture's.
export const section: GallerySection = {
  id: "status",
  title: "Status: badges, banners, sync, empty and loading",
  render: () => (
    <div className="tr-stack">
      <div className="tr-cluster">
        <StatusBadge status="ok" label="OK" />
        <StatusBadge status="near" label="Check" />
        <StatusBadge status="limit" label="Report" />
        <StatusBadge status="unread" label="Not done" />
        <StatusBadge status="nospare" label="No spare" />
      </div>
      <div className="tr-cluster">
        <StatusBadge status="ok" label="OK" size="md" />
        <StatusBadge status="near" label="Check" size="md" />
        <StatusBadge status="limit" label="Report" size="md" />
      </div>
      <div className="tr-cluster">
        <SeverityBadge severity="critical" label={severityLabel("CRITICAL")} count={4} />
        <SeverityBadge severity="warning" label={severityLabel("WARNING")} count={12} />
        <SeverityBadge severity="info" label={severityLabel("INFO")} />
        <SeverityBadge severity="critical" label={severityLabel("CRITICAL")} size="md" />
      </div>
      <div className="tr-cluster">
        <Badge>Fitted</Badge>
        <Badge>In store</Badge>
        <Badge icon={TyreIcon}>Spare</Badge>
      </div>
      <Banner tone="critical" title="1 inspection needs the office">
        The server refused it. Open it to see why.
      </Banner>
      <Banner
        tone="warning"
        title="Held on this phone for 2 days"
        action={<Button size="md">Sync now</Button>}
      >
        It sends when the signal returns.
      </Banner>
      <Banner tone="info" title="Sandbox data">
        Every figure here is an example.
      </Banner>
      <Banner tone="success" title="Inspection sent" />
      <div className="tr-cluster">
        <SyncStatus state="sent" />
        <SyncStatus state="saved" />
        <SyncStatus state="sending" count={3} />
        <SyncStatus state="waiting" count={2} onClick={() => undefined} />
        <SyncStatus state="failed" count={1} />
      </div>
      <EmptyState
        title="No exceptions"
        headingLevel={4}
        action={<Button variant="ghost">Refresh</Button>}
      >
        Nothing in the fleet is outside its configured policy.
      </EmptyState>
      <Skeleton />
    </div>
  ),
};

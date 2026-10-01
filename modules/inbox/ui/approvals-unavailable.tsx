import type { PageProps } from '@labelconsole/core/web';
import { EmptyState, Page, PageHeader } from '@labelconsole/ui';

/** Shown at /inbox/approvals when the Agents module (which owns approvals) isn't enabled. */
export default function ApprovalsUnavailablePage(_: PageProps) {
  return (
    <Page variant="narrow">
      <PageHeader title="Approvals" description="Risky actions agents want to take wait here for a person to decide." />
      <EmptyState icon="gavel" title="Agents aren't enabled for this label">
        Approvals come from AI agents. An owner can turn on the Agents module in Settings → Modules if your plan includes it.
      </EmptyState>
    </Page>
  );
}

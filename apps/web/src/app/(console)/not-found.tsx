import { EmptyState, LinkButton, Page } from '@labelconsole/ui';

export default function NotFound() {
  return (
    <Page>
      <EmptyState icon="search_off" title="Page not found" action={<LinkButton href="/" icon="grid_view">Back to dashboard</LinkButton>}>
        The page may have moved, or the module behind it is switched off for this label.
      </EmptyState>
    </Page>
  );
}

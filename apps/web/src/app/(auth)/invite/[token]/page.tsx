import { Suspense } from 'react';
import { peekInvitation } from '@labelconsole/core/auth';
import { EmptyState } from '@labelconsole/ui';
import { AuthForm } from '@/components/auth-form';
import '@/server/modules';

export const metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await peekInvitation(token);
  if (!inv)
    return (
      <div className="lc-auth">
        <EmptyState icon="link_off" title="This invitation is no longer valid">
          Ask an admin of the label to send a new one.
        </EmptyState>
      </div>
    );
  return (
    <Suspense>
      <AuthForm mode="invite" token={token} inviteLabel={inv.orgName} />
    </Suspense>
  );
}

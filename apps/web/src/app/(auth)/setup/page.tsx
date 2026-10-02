import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { setupNeeded } from '@labelconsole/core/auth';
import { env } from '@labelconsole/core/env';
import { AuthForm } from '@/components/auth-form';
import { getSession } from '@/server/session';

export const metadata = { title: 'Set up' };

/** Shown once, on the first visit: creates the label and its owner. Afterwards it only redirects. */
export default async function SetupPage() {
  if (await getSession()) redirect('/');
  if (!(await setupNeeded())) redirect('/login');
  return (
    <Suspense>
      <AuthForm mode="setup" labelName={env().LABEL_NAME} />
    </Suspense>
  );
}

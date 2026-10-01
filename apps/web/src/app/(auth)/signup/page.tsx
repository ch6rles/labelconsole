import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';
import { getSession } from '@/server/session';

export const metadata = { title: 'Create workspace' };

export default async function SignupPage() {
  if (await getSession()) redirect('/');
  return (
    <Suspense>
      <AuthForm mode="signup" />
    </Suspense>
  );
}

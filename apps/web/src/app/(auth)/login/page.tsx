import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';
import { getSession } from '@/server/session';

export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  return (
    <Suspense>
      <AuthForm mode="login" />
    </Suspense>
  );
}

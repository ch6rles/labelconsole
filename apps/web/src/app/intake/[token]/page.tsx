import { EmptyState } from '@labelconsole/ui';
import { orgForIntakeToken } from '@/server/intake';
import { IntakeForm } from './form';

export const metadata = { title: 'Submit a demo' };

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const org = await orgForIntakeToken(token);
  if (!org) return <div className="lc-auth"><EmptyState icon="link_off" title="This submission link is not valid" /></div>;
  return <IntakeForm token={token} label={org.name} />;
}

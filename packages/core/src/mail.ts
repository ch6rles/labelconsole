import type { ServiceContext } from './context';
import { ProviderError, ValidationError } from './errors';
import { readSecret } from './vault';

/**
 * Outbound email through the label's own SMTP credentials (vault provider
 * `smtp`). Worker-only, because it decrypts the credential. Callers pass an
 * idempotency key so a retried job never sends the same email twice.
 */
export type MailMessage = { to: string | string[]; subject: string; text: string; html?: string; replyTo?: string };

export async function sendMail(ctx: ServiceContext, msg: MailMessage): Promise<{ messageId: string }> {
  const cred = await readSecret(ctx, 'smtp');
  if (!cred) throw new ValidationError('No email account is connected. Add SMTP details under Settings → Integrations.');
  const { host, port, username, password, from, secure } = cred.secret;
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port: Number(port || 587),
    secure: secure === 'true' || Number(port) === 465,
    auth: username ? { user: username, pass: password } : undefined,
  });
  try {
    const info = await transport.sendMail({ from: from || username, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo });
    return { messageId: String(info.messageId ?? '') };
  } catch (err) {
    const code = (err as { responseCode?: number }).responseCode;
    // Network failures and 4xx "try again later" replies are transient; 5xx rejections are not.
    const transient = code === undefined || [421, 450, 451, 452].includes(code);
    throw new ProviderError('smtp', (err as Error).message, { transient, status: code });
  } finally {
    transport.close();
  }
}

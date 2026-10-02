/**
 * Make sure this installation's label (LABEL_NAME, "River Of Styxx" by
 * default) exists and that you own it, with the password you type. Creates
 * whatever is missing, so it also resets a forgotten password: there is no
 * public sign-up and no reset email.
 *
 *   pnpm owner --email you@example.com --name "Your Name"
 *   docker compose run --rm worker node dist/owner.js --email you@example.com
 *
 * The password is asked for without echoing it (or read from OWNER_PASSWORD).
 * It is never accepted as an argument, so it can't end up in shell history.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ensureOwner } from '@labelconsole/core/auth';
import { closeDb } from '@labelconsole/core/db/client';
import { env } from '@labelconsole/core/env';
import { EmailSchema, PasswordSchema } from '@labelconsole/core/schemas';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      // Show the prompt, hide the typed characters.
      if (s.includes(question)) out.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
const email = EmailSchema.safeParse(values.email ?? '');
if (!email.success) {
  console.error('Usage: pnpm owner --email you@example.com [--name "Your Name"]');
  process.exit(1);
}

let password = process.env.OWNER_PASSWORD ?? '';
if (!password) {
  password = await askHidden('Password (10+ characters): ');
  if (password !== (await askHidden('Same password again: '))) {
    console.error('The passwords did not match. Nothing was changed.');
    process.exit(1);
  }
}
const checked = PasswordSchema.safeParse(password);
if (!checked.success) {
  console.error(checked.error.issues[0]?.message ?? 'Invalid password');
  process.exit(1);
}

const r = await ensureOwner({ email: email.data, name: values.name, password: checked.data });
console.log(
  [
    r.createdLabel ? `Created the label "${r.org.name}".` : `The label "${r.org.name}" already existed.`,
    r.createdUser ? `Created the owner account ${r.user.email}.` : `Set a new password for ${r.user.email} (other sessions were signed out).`,
    `Sign in at ${env().APP_URL}/login`,
  ].join('\n'),
);
await closeDb();

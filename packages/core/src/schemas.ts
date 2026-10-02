import { z } from 'zod';

/** Validation shared by API routes and forms. */
export const EmailSchema = z.email('Enter a valid email').transform((s) => s.trim().toLowerCase());
export const PasswordSchema = z.string().min(10, 'Use at least 10 characters').max(200);

export const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1, 'Enter your password') });
export const SignupSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: EmailSchema,
  password: PasswordSchema,
  labelName: z.string().trim().min(1, 'Name your label').max(120),
});
export const SetupSchema = SignupSchema.omit({ labelName: true });
export const AcceptInviteSchema = z.object({ name: z.string().trim().max(120).optional(), password: z.string().max(200).optional() });
export const SwitchOrgSchema = z.object({ orgId: z.uuid() });

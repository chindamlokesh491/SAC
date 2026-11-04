// The implementation is plain JS so the staff:grant command can use it without a build step.
import { hashPassword, passwordProblem, temporaryPassword, verifyPassword } from '../../scripts/lib/password-hash.mjs';

export { hashPassword, passwordProblem, temporaryPassword, verifyPassword };

/** Verified against when the account does not exist, so response time does not reveal registered numbers. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(`unused-${Date.now()}-${Math.random()}`);
  return dummyHash;
}

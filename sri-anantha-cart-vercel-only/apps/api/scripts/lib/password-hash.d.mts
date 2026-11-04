export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, stored: string | null): Promise<boolean>;
export function temporaryPassword(): string;
export function passwordProblem(password: string, phoneE164: string | null): string | null;

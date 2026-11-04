export function databaseSslOptions(env?: Record<string, string | undefined>): { ssl?: { rejectUnauthorized: boolean; ca?: string } };

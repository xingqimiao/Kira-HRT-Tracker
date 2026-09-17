import { apiFetch } from './apiClient';

export interface User {
    id: string;
    username: string;
    isAdmin?: boolean;
}

export interface AuthResponse {
    token: string;
    user: User;
    needsSetup2FA?: boolean;
}

export interface Session {
    id: string;
    user_id: string;
    created_at: number;
    last_used_at: number;
    device_info: string;
    ip: string;
    is_current: boolean;
}

export interface TwoFAStatus {
    enabled: boolean;
    totp?: boolean;
}

export interface TwoFASetup {
    secret: string;
    uri: string;
}

/**
 * Read the `sid` claim out of a session token. Signing out has to name the
 * session row it wants destroyed, and reading it from the token rather than
 * from the login response means tokens minted before this shipped can be
 * revoked too. Nothing here trusts the value — the worker still scopes the
 * delete to the authenticated user.
 */
export function sessionIdFromToken(token: string | null): string | null {
    if (!token) return null;
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;
        const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
        return typeof claims?.sid === 'string' ? claims.sid : null;
    } catch {
        return null;
    }
}

export const authService = {
    async login(username: string, password: string, totpCode?: string, backupCode?: string): Promise<AuthResponse> {
        const body: { username: string; password: string; totp_code?: string; backup_code?: string } = { username, password };
        if (totpCode) body.totp_code = totpCode;
        if (backupCode) body.backup_code = backupCode;
        const res = await apiFetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const text = await res.text();
            let data: any;
            try { data = JSON.parse(text); } catch { /* ignore */ }
            if (data?.needs2FA) {
                const err = new Error('2FA_REQUIRED') as any;
                err.needs2FA = true;
                err.method = data.method ?? 'totp';
                throw err;
            }
            throw new Error(text);
        }
        return await res.json() as AuthResponse;
    },

    async register(username: string, password: string): Promise<AuthResponse> {
        const res = await apiFetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json() as AuthResponse;
    },

    async updateProfile(token: string, username: string): Promise<{ username: string }> {
        const res = await apiFetch('/api/user/profile', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ username })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    },

    async changePassword(token: string, current: string, newPass: string): Promise<void> {
        const res = await apiFetch('/api/user/password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ currentPassword: current, newPassword: newPass })
        });
        if (!res.ok) throw new Error(await res.text());
    },

    async deleteAccount(token: string, password: string, code?: string, backupCode?: string): Promise<void> {
        const body: { password: string; code?: string; backup_code?: string } = { password };
        if (code) body.code = code;
        if (backupCode) body.backup_code = backupCode;
        const res = await apiFetch('/api/user/me', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(await res.text());
    },

    async listSessions(token: string): Promise<Session[]> {
        const res = await apiFetch('/api/user/sessions', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json() as Session[];
    },

    async terminateSession(token: string, sessionId: string): Promise<void> {
        const res = await apiFetch(`/api/user/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
    },

    async terminateOtherSessions(token: string): Promise<void> {
        const res = await apiFetch('/api/user/sessions', {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
    },

    async get2FAStatus(token: string): Promise<TwoFAStatus> {
        const res = await apiFetch('/api/user/2fa/status', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json() as TwoFAStatus;
    },

    async setup2FA(token: string): Promise<TwoFASetup> {
        const res = await apiFetch('/api/user/2fa/setup', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json() as TwoFASetup;
    },

    /**
     * Writes the secret that gates login and replaces every backup code, so the
     * worker requires the password — a bearer token on its own is not proof
     * enough to hand someone a new second factor.
     */
    async enable2FA(token: string, secret: string, code: string, password: string, currentCode?: string): Promise<{ backupCodes: string[] }> {
        const body: { secret: string; code: string; password: string; currentCode?: string } = { secret, code, password };
        if (currentCode) body.currentCode = currentCode;
        const res = await apiFetch('/api/user/2fa/enable', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json() as { backupCodes: string[] };
    },

    /** Replaces every existing code, so the worker requires the password. */
    async generateBackupCodes(token: string, password: string): Promise<string[]> {
        const res = await apiFetch('/api/user/2fa/backup-codes/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ password }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json() as { codes: string[] };
        return data.codes;
    },

    async getBackupCodesStatus(token: string): Promise<{ remaining: number }> {
        const res = await apiFetch('/api/user/2fa/backup-codes', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json() as { remaining: number };
    },

    async disable2FA(token: string, password: string, code: string): Promise<void> {
        const res = await apiFetch('/api/user/2fa', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ password, code })
        });
        if (!res.ok) throw new Error(await res.text());
    },
};

import { apiFetch } from './apiClient';

export interface User {
    id: string;
    username: string;
    isAdmin?: boolean;
}

export interface AuthResponse {
    token: string;
    user: User;
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
    async login(username: string, password: string): Promise<AuthResponse> {
        const res = await apiFetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!res.ok) {
            throw new Error(await res.text());
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

    async deleteAccount(token: string, password: string): Promise<void> {
        const res = await apiFetch('/api/user/me', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ password })
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
};

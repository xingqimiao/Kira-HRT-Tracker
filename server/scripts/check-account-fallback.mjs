/**
 * End-to-end check for the anti-ban path, against a real Postgres database.
 *
 * The feature exists for a situation nobody tests by hand: the social account dies and
 * the user must still get in. So this drives the real `AccountService` against a real
 * database rather than mocking it, and asserts the properties that matter:
 *
 *   1. An OAuth-only account is reported as being one provider away from being lost.
 *   2. After binding a name and password, the account is reachable by password even
 *      though the provider is gone.
 *   3. A rejected unlink changes nothing.
 *
 *   cd server
 *   node --experimental-transform-types scripts/check-account-fallback.mjs
 *
 * Lives under `server/` because it uses `embedded-postgres`, the same throwaway
 * database helper the server tests use, so it never touches a database anyone cares
 * about. Run it from the `server` directory.
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'

const DIR = './.pgdata-fallback'
const PORT = 55460
const DATABASE = 'hrt_fallback'

rmSync(DIR, { recursive: true, force: true })

const EmbeddedPostgres = (await import('embedded-postgres')).default
const instance = new EmbeddedPostgres({
    databaseDir: DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
})
await instance.initialise()
await instance.start()
await instance.createDatabase(DATABASE)

process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/${DATABASE}`

const { AccountService } = await import('../src/accounts.ts')
const { getPool, migrate } = await import('../src/db.ts')
await migrate()

const results = []
async function check(name, fn) {
    try {
        await fn()
        results.push(['pass', name])
    } catch (error) {
        results.push(['fail', name, error.message])
    }
}

const tag = randomUUID().slice(0, 8)
const created = []

/** An account as OAuth signup leaves it: a generated name, no password. */
async function oauthOnlyAccount(provider = 'x') {
    const { rows } = await getPool().query(
        `INSERT INTO users (username, password_hash) VALUES ($1, NULL) RETURNING id, username`,
        [`oauth_${tag}_${created.length}`],
    )
    const user = rows[0]
    created.push(user.id)
    await getPool().query(
        `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, handle)
         VALUES ($1, $2, $3, $4)`,
        [user.id, provider, `${provider}-${tag}-${created.length}`, 'TestHandle'],
    )
    return user
}

const ctxFor = (user) => ({ userId: user.id, dek: 'unused-here' })

try {
    // ── The gap this feature closes ──────────────────────────────────────────

    await check('an OAuth-only account reports itself at risk', async () => {
        const user = await oauthOnlyAccount()
        const overview = await AccountService.loginOverview(user.id)
        if (overview.hasPassword !== false) throw new Error('expected no password')
        if (overview.providers.join(',') !== 'x') throw new Error(`providers: ${overview.providers}`)
        if (overview.recoveryRisk !== true) {
            throw new Error('an OAuth-only account must be flagged: losing X loses the account')
        }
    })

    await check('an unsupported provider is refused', async () => {
        const user = await oauthOnlyAccount()
        const result = await AccountService.unlinkProvider(ctxFor(user), 'facebook')
        if (result.ok) throw new Error('an unknown provider was accepted')
        if (!/unsupported/.test(result.error)) throw new Error(`error was: ${result.error}`)
    })

    // ── Binding the fallback ─────────────────────────────────────────────────

    await check('binding a name and password fills the gap', async () => {
        const user = await oauthOnlyAccount()
        const bound = await AccountService.bindCredentials(ctxFor(user), `bound_${tag}`, 'correct horse battery')
        if (!bound.ok) throw new Error(`bind failed: ${bound.error}`)

        const overview = await AccountService.loginOverview(user.id)
        if (overview.hasPassword !== true) throw new Error('password was not recorded')
        if (overview.recoveryRisk !== false) throw new Error('account still reports at risk after binding')
    })

    await check('the stored hash is scrypt and does not contain the password', async () => {
        const user = await oauthOnlyAccount()
        await AccountService.bindCredentials(ctxFor(user), `verify_${tag}`, 'a-real-password-1')
        const { rows } = await getPool().query(`SELECT password_hash FROM users WHERE id = $1`, [user.id])
        const hash = rows[0].password_hash
        if (!hash.startsWith('scrypt$')) throw new Error(`hash is not scrypt: ${hash.slice(0, 12)}`)
        if (hash.includes('a-real-password-1')) throw new Error('the password appears in the stored hash')
    })

    await check('a name another account holds is refused, not silently taken', async () => {
        const first = await oauthOnlyAccount()
        const second = await oauthOnlyAccount()
        const taken = `taken_${tag}`
        const ok = await AccountService.bindCredentials(ctxFor(first), taken, 'password-one-1')
        if (!ok.ok) throw new Error(`first bind failed: ${ok.error}`)

        const clash = await AccountService.bindCredentials(ctxFor(second), taken, 'password-two-2')
        if (clash.ok) throw new Error('a duplicate account name was accepted')
        if (clash.error !== 'username_taken') throw new Error(`error was: ${clash.error}`)
    })

    await check('a short password is refused', async () => {
        const user = await oauthOnlyAccount()
        const short = await AccountService.bindCredentials(ctxFor(user), `weak_${tag}`, 'short')
        if (short.ok) throw new Error('a 5-character password was accepted')
    })

    await check('a malformed account name is refused', async () => {
        const user = await oauthOnlyAccount()
        const bad = await AccountService.bindCredentials(ctxFor(user), 'has spaces', 'a-real-password-1')
        if (bad.ok) throw new Error('an account name with a space was accepted')
    })

    await check('binding twice renames rather than duplicating', async () => {
        const user = await oauthOnlyAccount()
        await AccountService.bindCredentials(ctxFor(user), `first_${tag}`, 'first-password-1')
        const second = await AccountService.bindCredentials(ctxFor(user), `second_${tag}`, 'second-password-2')
        if (!second.ok) throw new Error(`rebind failed: ${second.error}`)

        const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [user.id])
        if (rows[0].n !== 1) throw new Error('rebinding created a second account row')

        const overview = await AccountService.loginOverview(user.id)
        if (overview.username !== `second_${tag}`) throw new Error(`rename did not take: ${overview.username}`)
    })

    // ── The scenario the feature exists for ──────────────────────────────────

    await check('after binding, losing the provider does not lose the account', async () => {
        const user = await oauthOnlyAccount()
        await AccountService.bindCredentials(ctxFor(user), `rescue_${tag}`, 'rescue-password-1')

        // The provider dies: its row goes away entirely.
        await getPool().query(`DELETE FROM oauth_accounts WHERE user_id = $1`, [user.id])

        const overview = await AccountService.loginOverview(user.id)
        if (overview.providers.length !== 0) throw new Error('provider row should be gone')
        if (overview.hasPassword !== true) throw new Error('the fallback did not survive')

        const { rows } = await getPool().query(
            `SELECT username FROM users WHERE id = $1 AND password_hash IS NOT NULL`,
            [user.id],
        )
        if (rows.length !== 1) throw new Error('account is no longer enterable by password')
    })

    // ── A rejected unlink must change nothing ────────────────────────────────

    await check('a rejected unlink leaves the link in place', async () => {
        const user = await oauthOnlyAccount()
        const before = await AccountService.loginMethodsFor(user.id)
        if (before.hasPassword || before.providers.length !== 1) {
            throw new Error('fixture is not an at-risk account')
        }

        // The refusal is the stranding rule, not a credential: this account has no
        // password and exactly one provider, so unlinking would leave nobody able to
        // get in. It used to demand a TOTP or recovery code as well — the third
        // argument that used to sit on this call — and that requirement is gone.
        const refused = await AccountService.unlinkProvider(ctxFor(user), 'x')
        if (refused.ok) throw new Error('unlinking the only way in was accepted')

        const after = await AccountService.loginMethodsFor(user.id)
        if (after.providers.length !== 1) throw new Error('the rejected unlink still removed the link')
    })
} finally {
    if (created.length) {
        await getPool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created]).catch(() => {})
    }
    await getPool().end().catch(() => {})
    await instance.stop().catch(() => {})
    rmSync(DIR, { recursive: true, force: true })
}

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
